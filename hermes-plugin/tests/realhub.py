"""Helper that runs the REAL FoxFleet hub module (read-only Devin workspace) as a child process on an
ephemeral loopback port, plus the HTTP helpers the real hub's own bot tests use. Integration tests only."""

from __future__ import annotations

import asyncio
import codecs
import contextlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Optional

import aiohttp

from conftest import TEST_HUB_SERVER, TEST_NODE

LAUNCHER = Path(__file__).resolve().parent / "realhub" / "launch-hub.mjs"
PASSWORD = "correct horse battery"
AGENT = "helper"


def skip_reason() -> Optional[str]:
    if not TEST_NODE or not TEST_HUB_SERVER:
        return "FOXFLEET_TEST_NODE / FOXFLEET_TEST_HUB_SERVER are not set"
    if not Path(TEST_NODE).is_file():
        return f"node binary not found: {TEST_NODE}"
    if not (Path(TEST_HUB_SERVER) / "index.js").is_file():
        return f"hub server dir has no index.js: {TEST_HUB_SERVER}"
    return None


class Sse:
    """Incremental reader of a hub SSE response: events are {event, data, raw_data}."""

    def __init__(self, response: aiohttp.ClientResponse):
        self.response, self.events, self.ended = response, [], False
        self._task = asyncio.ensure_future(self._pump())

    async def _pump(self) -> None:
        buf = ""
        decoder = codecs.getincrementaldecoder("utf-8")()
        try:
            async for chunk in self.response.content.iter_any():
                buf += decoder.decode(chunk)
                while "\n\n" in buf:
                    block, buf = buf.split("\n\n", 1)
                    event, raw = "message", ""
                    for line in block.split("\n"):
                        if line.startswith("event:"):
                            event = line[6:].strip()
                        elif line.startswith("data:"):
                            raw += line[5:].strip()
                    try:
                        data: Any = json.loads(raw)
                    except ValueError:
                        data = raw
                    self.events.append({"event": event, "data": data, "raw_data": raw})
        except (aiohttp.ClientError, asyncio.CancelledError):
            pass
        self.ended = True

    def deltas(self) -> list[str]:
        return [e["data"]["choices"][0]["delta"]["content"] for e in self.events
                if e["event"] == "message" and isinstance(e["data"], dict) and e["data"].get("choices")]

    def text(self) -> str:
        """Reconstruct the reply: deltas appended, a foxfleet.replace event swaps the whole text."""
        text = ""
        for e in self.events:
            if e["event"] == "foxfleet.replace":
                text = e["data"]["text"]
            elif e["event"] == "message" and isinstance(e["data"], dict) and e["data"].get("choices"):
                text += e["data"]["choices"][0]["delta"]["content"]
        return text

    @property
    def done(self) -> bool:
        return bool(self.events) and self.events[-1]["raw_data"] == "[DONE]"

    async def close(self) -> None:
        self.response.close()
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)


class RealHub:
    def __init__(self, data_dir: Path, bot_options: Optional[dict] = None):
        self.dir = data_dir
        self.bot_options = bot_options or {}
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.port = 0
        self.token = ""
        self.session: Optional[aiohttp.ClientSession] = None
        self.agent_token = ""
        self.bot_id = ""

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def start(self) -> "RealHub":
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.dir), "LANG": "C.UTF-8"}
        self.proc = await asyncio.create_subprocess_exec(
            TEST_NODE, str(LAUNCHER), TEST_HUB_SERVER, str(self.dir / "config.json"), json.dumps(self.bot_options),
            env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            line = await asyncio.wait_for(self.proc.stdout.readline(), timeout=30)
            self.port = json.loads(line)["port"]
        except Exception as exc:
            err = b""
            if self.proc.returncode is not None:
                err = await self.proc.stderr.read(2000)
            await self._kill()
            raise RuntimeError(f"real hub did not start: {err.decode(errors='replace')}") from exc
        self.session = aiohttp.ClientSession()
        return self

    async def _kill(self) -> None:
        proc, self.proc = self.proc, None
        if proc is None or proc.returncode is not None:
            return
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=5)
        except (asyncio.TimeoutError, ProcessLookupError):
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()

    async def stop(self) -> None:
        if self.session is not None:
            await self.session.close()
            self.session = None
        await self._kill()

    async def restart(self) -> None:
        await self.stop()
        await self.start()

    # -- HTTP helpers (mirror server/test/bot-helpers.js) --------------------
    async def call(self, route: str, data: Any = None, *, method: Optional[str] = None, token: Optional[str] = None,
                   expect: Optional[int] = None) -> tuple[int, Any]:
        method = method or ("GET" if data is None else "POST")
        tok = self.token if token is None else token
        headers = {"Authorization": f"Bearer {tok}"} if tok else {}
        async with self.session.request(method, self.base + route, json=data, headers=headers) as res:
            body = await res.json(content_type=None) if res.content_length != 0 else None
            if expect is not None:
                assert res.status == expect, (route, res.status, body)
            return res.status, body

    async def setup_owner(self) -> None:
        _, body = await self.call("/api/auth/setup", {"username": "owner1", "password": PASSWORD, "client": "app"},
                                  token="", expect=200)
        self.token = body["token"]

    async def create_agent(self) -> None:
        await self.call("/api/connections", {"kind": "hermes", "connection": "bot", "name": AGENT}, expect=201)
        await self.mint_token()

    async def mint_token(self) -> str:
        _, body = await self.call(f"/api/agents/{AGENT}/bot-token", {}, expect=201)
        self.agent_token, self.bot_id = body["token"], body["bot_id"]
        return self.agent_token

    async def post_message(self, content: str, session_id: Optional[str] = None) -> dict:
        payload: dict = {"messages": [{"role": "user", "content": content}]}
        if session_id:
            payload["session_id"] = session_id
        _, body = await self.call(f"/api/agents/{AGENT}/messages", payload, expect=202)
        return body

    async def transcript(self, chat_id: str) -> list[dict]:
        _, body = await self.call(f"/api/agents/{AGENT}/sessions/{chat_id}/messages", expect=200)
        return [{"role": m["role"], "content": m["content"]} for m in body["messages"]]

    async def runs(self, chat_id: str) -> list[dict]:
        _, body = await self.call(f"/api/agents/{AGENT}/runs?session_id={chat_id}", expect=200)
        return body["runs"]

    async def follow_run(self, run_id: str) -> Sse:
        res = await self.session.get(f"{self.base}/api/agents/{AGENT}/runs/{run_id}/events",
                                     headers={"Authorization": f"Bearer {self.token}"})
        assert res.status == 200, res.status
        return Sse(res)

    async def commands(self) -> dict:
        _, body = await self.call(f"/api/agents/{AGENT}/commands", expect=200)
        return body

    async def rotate_token(self) -> str:
        return await self.mint_token()

    async def delete_agent(self) -> None:
        await self.call(f"/api/connections/{AGENT}", method="DELETE", expect=200)

    def store(self) -> dict:
        return json.loads((self.dir / "bot" / f"{self.bot_id}.json").read_text())


def make_data_dir() -> Path:
    return Path(tempfile.mkdtemp(prefix="foxfleet-realhub-"))


def remove_data_dir(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
