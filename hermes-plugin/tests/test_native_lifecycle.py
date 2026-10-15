"""Native lifecycle regressions: actual base/consumer and isolated real hub.

Deterministic handlers/runner shell only; no provider-backed inference. The shell calls
Hermes' real drain-notice implementation, preserving the runner's True-without-admission bug.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from gateway.run_busy import GatewayBusySessionMixin
from gateway.stream_consumer import GatewayStreamConsumer, StreamConsumerConfig
from foxfleet import protocol
from fakehub import wait_for
from test_realhub import real, make_adapter, _poll, _finished

pytestmark = pytest.mark.asyncio


class DrainRunner(GatewayBusySessionMixin):
    """Minimal deterministic runner shell, NOT a full GatewayRunner process."""
    _draining = False
    _external_drain_active = False
    _restart_requested = False
    _busy_input_mode = "interrupt"

    def __init__(self, adapter):
        self.adapter = adapter
        self.calls = []

    def _delivery_adapter_for(self, source):
        return self.adapter

    def _profile_name_for_source(self, source, **kwargs):
        return "default"

    def _status_action_gerund(self):
        return "shutting down"

    def _reply_anchor_for_event(self, event):
        return event.message_id

    def _thread_metadata_for_source(self, source, anchor=None):
        return None

    async def busy(self, event, key):
        self.calls.append(event.text)
        if self._draining:
            await self._send_busy_drain_notice(event, key, "interrupt")
            return True  # actual runner drain return: no acceptance, queue, or completed command
        self.adapter._pending_messages[key] = event
        event._gateway_accepted = True
        return True


async def test_drain_does_not_ack_consume_or_reconnect_and_retries_once(real, make_adapter):
    adapter = make_adapter()
    runner = DrainRunner(adapter)
    adapter.gateway_runner = runner
    release = asyncio.Event()
    seen = []

    async def handler(event):
        seen.append(event.text)
        if event.text == "long task":
            await release.wait()
        return "deterministic answer: " + event.text

    adapter.set_message_handler(handler)
    adapter.set_busy_session_handler(runner.busy)
    assert await adapter.connect()
    chat = (await real.post_message("long task"))["session_id"]
    await wait_for(lambda: seen == ["long task"])
    await wait_for(lambda: real.store()["acked"] == 1)
    runner._draining = True
    generation = adapter._generation
    await real.post_message("retain me", chat)
    await real.post_message("behind retained work")  # another chat: floor must not jump over event 2
    await asyncio.sleep(0.35)
    try:
        assert real.store()["acked"] == 1, "drain notice is not a gateway acceptance receipt"
        assert adapter._admitted == 1
        assert runner.calls == [], "do not repeatedly invoke a rejecting/draining busy handler"
        assert adapter._generation == generation, "drain must pause admission, not reconnect-loop"
        # Reader still services RPCs while admission is paused (no busy handler/reader deadlock).
        assert (await asyncio.wait_for(adapter.send(chat, "interim while draining"), 2)).success
        runner._draining = False
        await wait_for(lambda: real.store()["acked"] == 3)
        release.set()
        await wait_for(lambda: len(seen) == 3)
        assert sorted(seen) == sorted(["long task", "retain me", "behind retained work"])
        assert runner.calls == ["retain me"]
        assert adapter._generation == generation
    finally:
        runner._draining = False
        release.set()


@pytest.mark.parametrize("mode", ["existing-overflow", "first-overflow", "final-only"])
async def test_large_unicode_stream_is_one_run_until_true_completion(real, make_adapter, mode):
    adapter = make_adapter()
    seen = []

    async def handler(event):
        seen.append(event)
        return None  # deterministic fixture, stream driven below, not an inference run

    adapter.set_message_handler(handler)
    assert await adapter.connect()
    chat = (await real.post_message("large stream"))["session_id"]
    await wait_for(lambda: seen)
    old = await adapter.send(chat, "unrelated message")
    assert old.success
    run = (await real.runs(chat))[0]
    sse = await real.follow_run(run["id"])
    consumer = GatewayStreamConsumer(adapter, chat, StreamConsumerConfig(
        edit_interval=0.01, buffer_threshold=1, cursor=""))
    task = asyncio.create_task(consumer.run())
    head = "prefix🦊漢é" * 7000
    tail = "END🦊漢" * 300
    full = head + tail
    try:
        if mode == "existing-overflow":
            consumer.on_delta(head[:1000])
            await asyncio.sleep(0.15)
            consumer.on_delta(head[1000:])
        else:
            consumer.on_delta(head)
        if mode != "final-only":
            await _poll(lambda: real.transcript(chat),
                        lambda rows: sum(len(r["content"]) for r in rows if r["role"] == "assistant") >= len(head))
            runs = await real.runs(chat)
            assert len(runs) == 1 and runs[0]["state"] not in ("done", "stopped"), \
                "overflow chunk sealing must not complete the logical run"
            assert not sse.ended
        consumer.on_delta(tail)
        consumer.finish(full)
        await asyncio.wait_for(task, 5)
        await _finished(sse, 5)
        rows = await real.transcript(chat)
        replies = [r["content"] for r in rows if r["role"] == "assistant"]
        assert replies[0] == "unrelated message"
        assert "".join(replies[1:]) == full, "split delivery must be lossless and ordered, with no chunk indicators"
        assert all(protocol.utf8_len(t) <= protocol.MAX_TEXT_BYTES for t in replies)
        runs = await real.runs(chat)
        assert len(runs) == 1 and runs[0]["state"] == "done"
        # The real hub deliberately joins separate message bubbles with two newlines.
        assert sse.done and sse.text() == "\n\n".join(replies)
        assert consumer.final_response_sent and consumer.delivered_final_matches(full) is True
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await sse.close()


@pytest.mark.parametrize("notice", ["status", "busy-ack", "busy-notify", "interim-segment"])
async def test_notices_do_not_finish_active_stream(real, make_adapter, notice):
    adapter = make_adapter()
    release = asyncio.Event()
    consumers = []
    seen = []

    async def handler(event):
        seen.append(event.text)
        if event.text == "/status":
            return "deterministic status: working"
        consumer = GatewayStreamConsumer(adapter, event.source.chat_id, StreamConsumerConfig(
            edit_interval=0.01, buffer_threshold=1, cursor=""))
        consumers.append(consumer)
        task = asyncio.create_task(consumer.run())
        consumer.on_delta("answer preview")
        try:
            await release.wait()
            consumer.on_delta(" completed")
            consumer.finish("answer preview completed")
            await task
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        return None

    async def busy(event, key):
        # Real busy-notice sender, deterministic acceptance instead of an agent steer.
        shell = DrainRunner(adapter)
        if notice == "busy-notify":
            await adapter._send_with_retry(event.source.chat_id, "notified, but not final",
                                           metadata={"notify": True})
        else:
            await shell._send_busy_reply(event, adapter, "deterministic busy: retained")
        event._gateway_accepted = True
        return True

    adapter.set_message_handler(handler)
    adapter.set_busy_session_handler(busy)
    assert await adapter.connect()
    chat = (await real.post_message("stream"))["session_id"]
    await wait_for(lambda: consumers)
    await _poll(lambda: real.transcript(chat), lambda rows: len(rows) >= 2)
    run = (await real.runs(chat))[0]
    sse = await real.follow_run(run["id"])
    try:
        if notice == "interim-segment":
            consumers[0].on_segment_break()
            consumers[0].on_commentary("deterministic interim")
            await _poll(lambda: real.transcript(chat), lambda rows: len(rows) >= 3)
        else:
            await real.post_message("/status" if notice == "status" else "steer", chat)
            await wait_for(lambda: real.store()["acked"] == 2)
        await asyncio.sleep(0.1)
        runs = await real.runs(chat)
        assert len(runs) == 1 and runs[0]["state"] not in ("done", "stopped"), \
            "busy/inline-status/interim notices must not terminate the active answer"
        assert not sse.ended
        release.set()
        await _finished(sse, 5)
        rows = await real.transcript(chat)
        assert {"role": "assistant", "content": "answer preview completed"} in rows
        assert len(await real.runs(chat)) == 1 and sse.done
    finally:
        release.set()
        await sse.close()


@pytest.mark.parametrize("command", ["/status", "/stop"])
async def test_idle_command_reply_finishes_promptly(real, make_adapter, command):
    adapter = make_adapter()

    async def handler(event):
        return "deterministic command reply: " + event.text

    adapter.set_message_handler(handler)
    assert await adapter.connect()
    chat = (await real.post_message(command))["session_id"]
    run = (await _poll(lambda: real.runs(chat)))[0]
    sse = await real.follow_run(run["id"])
    try:
        await _finished(sse, 5)
        assert sse.done
        assert (await real.runs(chat))[0]["state"] == "done"
        assert (await real.transcript(chat))[-1]["content"].endswith(command)
    finally:
        await sse.close()


async def test_active_stop_reply_finishes_and_cancels_old_task(real, make_adapter):
    adapter = make_adapter()
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def handler(event):
        if event.text == "/stop":
            return "deterministic stopped"
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    adapter.set_message_handler(handler)
    assert await adapter.connect()
    chat = (await real.post_message("long task"))["session_id"]
    await asyncio.wait_for(started.wait(), 5)
    run = (await real.runs(chat))[0]
    sse = await real.follow_run(run["id"])
    try:
        await real.post_message("/stop", chat)
        await _finished(sse, 5)
        await asyncio.wait_for(cancelled.wait(), 5)
        await wait_for(lambda: real.store()["acked"] == 2)
        assert (await real.transcript(chat))[-1] == {"role": "assistant", "content": "deterministic stopped"}
        assert len(await real.runs(chat)) == 1 and sse.done
    finally:
        await sse.close()


@pytest.mark.parametrize("flag", ["_draining", "_external_drain_active"])
async def test_cold_drain_disconnect_replays_once_without_advancing_floor(real, make_adapter, flag):
    adapter = make_adapter()
    runner = DrainRunner(adapter)
    setattr(runner, flag, True)
    adapter.gateway_runner = runner
    seen = []

    async def handler(event):
        seen.append(event.text)
        return "deterministic replay answer"

    adapter.set_message_handler(handler)
    assert await adapter.connect()
    await real.post_message("retained through restart")
    await asyncio.sleep(0.2)
    assert seen == [] and real.store()["acked"] == adapter._admitted == 0
    generation = adapter._generation
    await asyncio.wait_for(adapter.disconnect(), 2)
    assert real.store()["acked"] == 0 and adapter._generation == generation
    setattr(runner, flag, False)
    assert await adapter.connect()
    await wait_for(lambda: seen == ["retained through restart"])
    await wait_for(lambda: real.store()["acked"] == 1)
    await asyncio.sleep(0.1)
    assert seen == ["retained through restart"]


async def test_native_snapshot_correction_keeps_ids_scoped_and_unicode_lossless(real, make_adapter):
    adapter = make_adapter()
    adapter.set_message_handler(lambda e: asyncio.sleep(0))
    assert await adapter.connect()
    chat = (await real.post_message("correct final"))["session_id"]
    await wait_for(lambda: real.store()["acked"] == 1)
    unrelated = await adapter.send(chat, "unrelated stays intact")
    consumer = GatewayStreamConsumer(adapter, chat, StreamConsumerConfig(
        edit_interval=0.01, buffer_threshold=1, cursor="▉"))
    task = asyncio.create_task(consumer.run())
    preview = ("🦊漢 line\n" * 9000) + "stale tail"
    consumer.on_delta(preview)
    await _poll(lambda: real.transcript(chat), lambda rows: len(rows) >= 4)
    final = "corrected final 🦊漢"
    consumer.finish(final)
    await asyncio.wait_for(task, 5)
    rows = await real.transcript(chat)
    assert [r["content"] for r in rows if r["role"] == "assistant"] == ["unrelated stays intact", final]
    assert consumer.delivered_final_matches(final) is True
    assert len(await real.runs(chat)) == 1
    # A duplicate terminal frame is a no-op, not a new message/run.
    assert await adapter.send_stream_frame(final, chat_id=chat, turn_id=consumer._turn_id, finalize=True)
    assert await real.transcript(chat) == rows


@pytest.mark.parametrize("clear_after_notice", [False, True])
async def test_drain_race_inside_busy_callback_self_heals_with_one_notice_and_no_replay(real, make_adapter, clear_after_notice):
    """An unproven busy True during drain is never replayed (at most once) and never kills the
    channel: the event is resolved with ONE explicit user-visible notice and the channel continues."""
    from foxfleet.adapter import ADMISSION_UNCERTAIN_NOTICE
    adapter = make_adapter()
    runner = DrainRunner(adapter)
    adapter.gateway_runner = runner
    release, entered, scoped = asyncio.Event(), asyncio.Event(), asyncio.Event()
    seen = []

    async def handler(event):
        seen.append(event.text)
        if event.text == "long task":
            await release.wait()
        return "deterministic answer: " + event.text

    async def delayed_busy(event, key):
        entered.set()
        await scoped.wait()  # models the runner's asynchronous profile-scope entry
        result = await runner.busy(event, key)
        if clear_after_notice:
            runner._draining = False  # drain canceled during the notice RPC round trip
        return result

    fatal = []
    adapter.set_message_handler(handler)
    adapter.set_busy_session_handler(delayed_busy)
    adapter.set_fatal_error_handler(lambda a: fatal.append(a.fatal_error_code))
    assert await adapter.connect()
    chat = (await real.post_message("long task"))["session_id"]
    await wait_for(lambda: seen == ["long task"])
    await wait_for(lambda: real.store()["acked"] == 1)
    generation = adapter._generation
    await real.post_message("scope raced drain", chat)
    await asyncio.wait_for(entered.wait(), 5)
    runner._draining = True
    scoped.set()
    try:
        # Resolved, not retried: acked once so the hub never redelivers a possibly-applied steer.
        await wait_for(lambda: real.store()["acked"] == 2)
        assert adapter._admitted == 2
        notices = await _poll(lambda: real.transcript(chat),
                              lambda rows: [r for r in rows if r["content"] == ADMISSION_UNCERTAIN_NOTICE])
        assert len([r for r in notices if r["content"] == ADMISSION_UNCERTAIN_NOTICE]) == 1
        await asyncio.sleep(0.3)
        assert fatal == [] and adapter.is_connected and adapter._generation == generation
        assert runner.calls == ["scope raced drain"] and "scope raced drain" not in seen
        # The channel keeps serving once the drain clears.
        runner._draining = False
        other = (await real.post_message("after the drain"))["session_id"]
        await wait_for(lambda: "after the drain" in seen)
        await wait_for(lambda: real.store()["acked"] == 3)
        # A forced resync never replays the resolved event.
        await adapter._conn.ws.close()
        await wait_for(lambda: adapter._conn is not None and adapter._generation > generation, timeout=5)
        await asyncio.sleep(0.3)
        assert runner.calls == ["scope raced drain"] and seen.count("after the drain") == 1
        rows = await real.transcript(chat)
        assert [r["content"] for r in rows].count(ADMISSION_UNCERTAIN_NOTICE) == 1
        await _poll(lambda: real.transcript(other),
                    lambda rows: rows[-1]["content"] == "deterministic answer: after the drain")
    finally:
        release.set()
        runner._draining = False


async def test_drain_after_ack_before_handler_start_is_never_lost_silently(real, make_adapter):
    """Audit hypothesis: base accepted (and the adapter ACKed) an event, then a drain began before its
    handler ran; the drained gateway cancels the held task. The ACKed message must not vanish
    silently: the next connect sends ONE resend notice for it (it is never replayed: it was ACKed)."""
    from foxfleet.adapter import UNPROCESSED_NOTICE
    adapter = make_adapter()
    runner = DrainRunner(adapter)
    adapter.gateway_runner = runner
    seen = []

    async def handler(event):
        seen.append(event.text)
        return "deterministic answer: " + event.text

    original_start = adapter.on_processing_start

    async def drain_begins(event):  # DETERMINISTIC: drain starts after acceptance, before the handler
        runner._draining = True
        await original_start(event)

    adapter.on_processing_start = drain_begins
    adapter.set_message_handler(handler)
    assert await adapter.connect()
    chat = (await real.post_message("accepted, then drained"))["session_id"]
    await wait_for(lambda: real.store()["acked"] == 1)
    await asyncio.sleep(0.3)
    assert seen == []
    await adapter.cancel_background_tasks()  # the runner's drain-timeout shutdown order
    await adapter.disconnect()
    restarted = make_adapter()
    restarted.set_message_handler(handler)
    assert await restarted.connect()
    await _poll(lambda: real.transcript(chat),
                lambda rows: [r for r in rows if r["content"] == UNPROCESSED_NOTICE])
    await asyncio.sleep(0.3)
    rows = await real.transcript(chat)
    assert [r["content"] for r in rows].count(UNPROCESSED_NOTICE) == 1 and seen == []
    await restarted.disconnect()
    again = make_adapter()
    again.set_message_handler(handler)
    assert await again.connect()
    await asyncio.sleep(0.3)
    assert [r["content"] for r in await real.transcript(chat)].count(UNPROCESSED_NOTICE) == 1


async def test_processed_held_message_never_gets_a_false_resend_notice_after_a_crash(real, make_adapter, monkeypatch):
    """0.3.12 drain persistence race: a message held behind a drain is released and PROCESSED, but the
    removal of its held-record fails to save (transient disk error). Before the fix the removal was only
    retried on the next flush (a reconnect), so a crash in between left the record on disk and the
    restarted gateway told the user 'not processed, please resend' for a message that was answered."""
    import errno
    import json
    from foxfleet import adapter as ff
    from foxfleet.adapter import UNPROCESSED_NOTICE
    real_write = ff.atomic_json_write
    fail_next = {"n": 0}

    def flaky_write(*args, **kwargs):
        if fail_next["n"] > 0:
            fail_next["n"] -= 1
            raise OSError(errno.EIO, "I/O error")
        return real_write(*args, **kwargs)

    monkeypatch.setattr(ff, "atomic_json_write", flaky_write)
    import time as _time
    real_sleep = _time.sleep
    blocked = []

    def no_blocking_sleep(seconds):  # the retry must not block the event loop (Soran, 0.3.12)
        if seconds >= 0.01:
            blocked.append(seconds)
        return real_sleep(seconds)

    monkeypatch.setattr(ff.time, "sleep", no_blocking_sleep)
    adapter = make_adapter()
    runner = DrainRunner(adapter)
    adapter.gateway_runner = runner
    seen = []

    async def handler(event):
        seen.append(event.text)
        return "deterministic answer: " + event.text

    original_start = adapter.on_processing_start

    async def drain_begins(event):
        runner._draining = True
        await original_start(event)

    adapter.on_processing_start = drain_begins
    original_release = adapter._release_unprocessed

    async def release_with_disk_errors(key):
        fail_next["n"] = 2  # the first save AND the quick retry fail; the disk then recovers
        await original_release(key)

    adapter._release_unprocessed = release_with_disk_errors
    adapter.set_message_handler(handler)
    try:
        assert await adapter.connect()
        chat = (await real.post_message("held, then processed"))["session_id"]
        await wait_for(lambda: adapter._unprocessed, timeout=5)
        runner._draining = False  # the drain clears: the held handler runs
        await wait_for(lambda: seen == ["held, then processed"], timeout=5)

        def on_disk():
            try:
                return json.loads(adapter._state_path.read_text()).get("unprocessed", [])
            except (OSError, ValueError):
                return None
        # The removal must reach the disk WITHOUT a reconnect/flush (bounded: base backoff 0.1 s).
        await wait_for(lambda: on_disk() == [], timeout=3)
    finally:
        runner._draining = False
    # Crash: tasks die, nothing graceful runs; a new gateway process starts from the disk state.
    await adapter.cancel_background_tasks()
    await adapter.disconnect()
    restarted = make_adapter()
    restarted.set_message_handler(handler)
    assert await restarted.connect()
    await asyncio.sleep(0.5)
    rows = await real.transcript(chat)
    assert [r["content"] for r in rows].count(UNPROCESSED_NOTICE) == 0
    assert seen == ["held, then processed"]
    assert blocked == [], "a synchronous sleep blocked the event loop"
    await restarted.disconnect()
