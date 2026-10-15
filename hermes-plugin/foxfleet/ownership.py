"""Host-wide, crash-safe ownership of one bot token.

The hub keeps ONE socket per bot and closes the older one, so two clients dialling with the same
token fight each other. Hermes' scoped lock is advisory (pid files); this adds an OS file lock held
for the life of the connection, which the kernel releases on any exit, crash included.
"""

from __future__ import annotations

import errno
import hashlib
import os
from pathlib import Path
from typing import Optional

from gateway.status import _get_lock_dir

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore[assignment]
    import msvcrt

_HELD = {errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK, errno.EDEADLK}


class BotLock:
    """Non-blocking exclusive lock keyed by the token identity; the token itself is never written."""

    def __init__(self, identity: str):
        digest = hashlib.sha256(identity.encode()).hexdigest()[:32]
        self.path: Path = _get_lock_dir() / f"foxfleet-bot-{digest}.flock"
        self._fd: Optional[int] = None

    def acquire(self) -> bool:
        if self._fd is not None:
            return True
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:  # pragma: no cover - Windows
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            os.close(fd)
            if exc.errno in _HELD:
                return False
            raise
        self._fd = fd
        return True

    def release(self) -> None:
        fd, self._fd = self._fd, None
        if fd is None:
            return
        try:
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_UN)
            else:  # pragma: no cover - Windows
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        finally:
            os.close(fd)
