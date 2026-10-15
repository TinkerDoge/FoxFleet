"""Native-stream failure recovery against the REAL hub and the REAL Hermes stream consumer.

Faults are DETERMINISTIC INJECTIONS at the adapter's own RPC seam (``adapter._request``): a request
either never leaves the process (``_NotSent``) or reaches the real hub whose response is then dropped
(``_OutcomeUnknown`` after the real call). Everything else (the hub, the socket, the consumer's
native/fallback code, run bookkeeping, transcript) is real. No LLM/provider is called.
"""
from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio

from gateway.stream_consumer import GatewayStreamConsumer, StreamConsumerConfig
from foxfleet import protocol
from foxfleet.adapter import _NotSent, _OutcomeUnknown
from fakehub import wait_for
from realhub import RealHub, make_data_dir, remove_data_dir
from test_realhub import real, make_adapter, _poll, _finished  # noqa: F401  (fixtures)

pytestmark = pytest.mark.asyncio


class Fault:
    """DETERMINISTIC FAULT INJECTION on ``adapter._request`` for one hub operation."""

    def __init__(self, adapter, op, *, times=1, lost_response=False, when=None, skip=0):
        self.adapter, self.op, self.left, self.lost, self.when = adapter, op, times, lost_response, when
        self.skip = skip
        self.hits: list[dict] = []
        self._real = adapter._request
        adapter._request = self._call

    async def _call(self, op, *, retry_unknown, **params):
        if op == self.op and self.left > 0 and (self.when is None or self.when(params)):
            if self.skip > 0:
                self.skip -= 1
                return await self._real(op, retry_unknown=retry_unknown, **params)
            self.left -= 1
            self.hits.append(params)
            if self.lost:
                await self._real(op, retry_unknown=retry_unknown, **params)  # reaches the real hub
                raise _OutcomeUnknown("INJECTED: hub response lost")
            raise _NotSent("INJECTED: request never sent")
        return await self._real(op, retry_unknown=retry_unknown, **params)


class Observer:
    """Records every real hub response code per operation (no fault injected)."""

    def __init__(self, adapter):
        self.codes: list[tuple[str, str]] = []
        self._real = adapter._request
        adapter._request = self._call

    async def _call(self, op, *, retry_unknown, **params):
        res = await self._real(op, retry_unknown=retry_unknown, **params)
        self.codes.append((op, "ok" if res.ok else res.error_code))
        return res


@pytest_asyncio.fixture
async def tight_hub():
    """A second REAL hub whose per-bot token bucket is tiny (burst 4, 2 requests/s)."""
    data_dir = make_data_dir()
    hub = RealHub(data_dir, {"rate": {"burst": 4, "perSec": 2}})
    try:
        await hub.start()
        await hub.setup_owner()
        await hub.create_agent()
        yield hub
    finally:
        await hub.stop()
        remove_data_dir(data_dir)


async def _open_chat(real, make_adapter, text="stream with faults", **adapter_kwargs):
    adapter, seen = make_adapter(**adapter_kwargs), []

    async def handler(event):
        seen.append(event)
        return None  # DETERMINISTIC TEST HANDLER (no LLM/provider): the stream is driven by the test

    adapter.set_message_handler(handler)
    assert await adapter.connect()
    chat = (await real.post_message(text))["session_id"]
    await wait_for(lambda: seen)
    await wait_for(lambda: real.store()["acked"] == 1)
    run = (await real.runs(chat))[0]
    sse = await real.follow_run(run["id"])
    return adapter, chat, sse


def _consumer(adapter, chat, cursor=""):
    return GatewayStreamConsumer(adapter, chat, StreamConsumerConfig(
        edit_interval=0.01, buffer_threshold=1, cursor=cursor))


async def _assistant(real, chat):
    return [r["content"] for r in await real.transcript(chat) if r["role"] == "assistant"]


async def _assert_open(real, chat, sse):
    runs = await real.runs(chat)
    assert len(runs) == 1 and runs[0]["state"] not in ("done", "stopped"), runs
    assert not sse.ended, "the run must stay open until the true final"


async def _assert_single_final(real, chat, sse, consumer, full, *, replies=None):
    await _finished(sse, 10)
    replies = replies if replies is not None else await _assistant(real, chat)
    assert "".join(replies) == full, "exactly the final text, once, ordered and lossless"
    assert all(protocol.utf8_len(t) <= protocol.MAX_TEXT_BYTES for t in replies)
    runs = await real.runs(chat)
    assert len(runs) == 1 and runs[0]["state"] == "done", runs
    assert sse.done and sse.text() == "\n\n".join(replies)
    assert consumer.final_response_sent and consumer.delivered_final_matches(full) is True


async def _stop(task, sse):
    if not task.done():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    await sse.close()


async def test_transient_mid_stream_edit_failure_keeps_one_run_without_duplicate(real, make_adapter):
    """The audit reproduction: one injected _NotSent on the next message.edit."""
    adapter, chat, sse = await _open_chat(real, make_adapter)
    consumer = _consumer(adapter, chat)
    task = asyncio.create_task(consumer.run())
    full = "part one part two part three"
    try:
        consumer.on_delta("part one ")
        await _poll(lambda: _assistant(real, chat), lambda rows: rows == ["part one "])
        fault = Fault(adapter, "message.edit")
        consumer.on_delta("part two ")
        async def fault_hits():
            return list(fault.hits)
        await _poll(fault_hits, lambda hits: len(hits) == 1)
        await _assert_open(real, chat, sse)
        consumer.on_delta("part three")
        consumer.finish(full)
        await asyncio.wait_for(task, 10)
        await _assert_single_final(real, chat, sse, consumer, full)
    finally:
        await _stop(task, sse)


@pytest.mark.parametrize("lost_response", [False, True], ids=["not-sent", "response-lost"])
async def test_first_frame_failure_keeps_one_run_and_leaves_no_orphan(real, make_adapter, lost_response):
    adapter, chat, sse = await _open_chat(real, make_adapter)
    fault = Fault(adapter, "message.send", lost_response=lost_response)
    consumer = _consumer(adapter, chat)
    task = asyncio.create_task(consumer.run())
    full = "first frame 🦊 then the rest"
    try:
        consumer.on_delta("first frame 🦊")
        await wait_for(lambda: fault.hits)
        await asyncio.sleep(0.2)
        await _assert_open(real, chat, sse)
        consumer.on_delta(" then the rest")
        consumer.finish(full)
        await asyncio.wait_for(task, 10)
        await _assert_single_final(real, chat, sse, consumer, full)
    finally:
        await _stop(task, sse)


async def test_unsent_replay_of_a_lost_response_keeps_its_idempotency_key(real, make_adapter):
    """Lost response on the first chunk, then its verbatim replay never leaves the process: the
    unknown outcome must keep its key, or the next replay creates an orphan duplicate bubble."""
    adapter, chat, sse = await _open_chat(real, make_adapter)
    lost = Fault(adapter, "message.send", lost_response=True)
    unsent = Fault(adapter, "message.send", skip=1)  # the replay after the lost response
    consumer = _consumer(adapter, chat)
    task = asyncio.create_task(consumer.run())
    full = "first 🦊 second 漢 third"
    try:
        consumer.on_delta("first 🦊")
        await wait_for(lambda: lost.hits)
        await asyncio.sleep(0.2)
        consumer.on_delta(" second 漢")
        await wait_for(lambda: unsent.hits)
        await asyncio.sleep(0.2)
        assert unsent.hits[0]["idempotency_key"] == lost.hits[0]["idempotency_key"]
        await _assert_open(real, chat, sse)
        consumer.on_delta(" third")
        consumer.finish(full)
        await asyncio.wait_for(task, 10)
        await _assert_single_final(real, chat, sse, consumer, full)
    finally:
        await _stop(task, sse)


@pytest.mark.parametrize("lost_response", [False, True], ids=["not-sent", "response-lost"])
async def test_middle_chunk_failure_of_large_snapshot_is_lossless_in_one_run(real, make_adapter, lost_response):
    adapter, chat, sse = await _open_chat(real, make_adapter)
    head = "prefix🦊漢é\n" * 10000  # ~160 KiB: three hub messages
    tail = "END🦊漢" * 300
    full = head + tail
    assert len(protocol.split_text(head)) == 3
    fault = Fault(adapter, "message.send", skip=1, lost_response=lost_response)  # the 2nd chunk
    consumer = _consumer(adapter, chat)
    task = asyncio.create_task(consumer.run())
    try:
        consumer.on_delta(head)
        await wait_for(lambda: fault.hits)
        assert fault.hits[0]["reply_to"] is None and fault.hits[0]["text"] == protocol.split_text(head)[1]
        await asyncio.sleep(0.3)
        await _assert_open(real, chat, sse)
        consumer.on_delta(tail)
        consumer.finish(full)
        await asyncio.wait_for(task, 10)
        await _assert_single_final(real, chat, sse, consumer, full)
    finally:
        await _stop(task, sse)


@pytest.mark.parametrize("lost_response", [False, True], ids=["not-sent", "response-lost"])
async def test_final_frame_failure_is_delivered_once_into_the_same_messages(real, make_adapter, lost_response):
    adapter, chat, sse = await _open_chat(real, make_adapter)
    consumer = _consumer(adapter, chat)
    task = asyncio.create_task(consumer.run())
    full = "streamed answer, then the authoritative final 🦊"
    try:
        consumer.on_delta("streamed answer")
        await _poll(lambda: _assistant(real, chat), lambda rows: rows == ["streamed answer"])
        fault = Fault(adapter, "message.edit", lost_response=lost_response, when=lambda p: p["final"] is True)
        consumer.finish(full)
        await asyncio.wait_for(task, 10)
        assert len(fault.hits) == 1
        await _assert_single_final(real, chat, sse, consumer, full)
        await asyncio.sleep(0.3)
        assert await _assistant(real, chat) == [full] and len(await real.runs(chat)) == 1
    finally:
        await _stop(task, sse)


async def test_final_that_fallback_cannot_deliver_is_completed_by_the_gateway_final_send(real, make_adapter):
    adapter, chat, sse = await _open_chat(real, make_adapter)
    consumer = _consumer(adapter, chat)
    task = asyncio.create_task(consumer.run())
    full = "preview text, then a final the consumer could not deliver 🦊"
    try:
        consumer.on_delta("preview text")
        await _poll(lambda: _assistant(real, chat), lambda rows: rows == ["preview text"])
        # final frame, Hermes' best-effort close and its send() fallback all fail
        fault = Fault(adapter, "message.edit", times=3, when=lambda p: p["final"] is True)
        consumer.finish(full)
        await asyncio.wait_for(task, 10)
        assert len(fault.hits) == 3 and not fault.left
        assert consumer.final_response_sent is False, "an undelivered final must not be reported as sent"
        await _assert_open(real, chat, sse)
        # The gateway's normal final send (real BasePlatformAdapter._send_with_retry) completes in place.
        result = await adapter._send_with_retry(chat_id=chat, content=full, metadata={"notify": True})
        assert result.success
        await _finished(sse, 10)
        assert await _assistant(real, chat) == [full]
        runs = await real.runs(chat)
        assert len(runs) == 1 and runs[0]["state"] == "done" and sse.done and sse.text() == full
    finally:
        await _stop(task, sse)


async def test_final_that_cannot_be_delivered_fails_visibly_without_success(real, make_adapter, caplog):
    adapter, chat, sse = await _open_chat(real, make_adapter)
    consumer = _consumer(adapter, chat)
    task = asyncio.create_task(consumer.run())
    full = "preview text, then a final the hub never confirms"
    try:
        consumer.on_delta("preview text")
        await _poll(lambda: _assistant(real, chat), lambda rows: rows == ["preview text"])
        Fault(adapter, "message.edit", times=10**6, when=lambda p: p["final"] is True)
        with caplog.at_level("ERROR", logger="foxfleet.adapter"):
            consumer.finish(full)
            await asyncio.wait_for(task, 10)
            result = await adapter.send(chat, full, metadata={"notify": True})
        assert consumer.final_response_sent is False
        assert result.success is False and result.retryable is True
        assert any("not delivered" in r.getMessage() for r in caplog.records if r.levelname == "ERROR")
        assert await _assistant(real, chat) == ["preview text"], "no duplicate bubble for an undelivered final"
        await _assert_open(real, chat, sse)
    finally:
        await _stop(task, sse)


async def test_rate_limited_stream_frames_still_deliver_the_final_once_in_one_run(tight_hub, make_adapter):
    adapter, chat, sse = await _open_chat(tight_hub, make_adapter, token=tight_hub.agent_token, hub=tight_hub)
    observed = Observer(adapter)
    consumer = _consumer(adapter, chat)
    task = asyncio.create_task(consumer.run())
    full = "a streamed preview 🦊, then the final while the bucket is empty."
    try:
        consumer.on_delta("a streamed preview 🦊")
        await _poll(lambda: _assistant(tight_hub, chat), lambda rows: rows == ["a streamed preview 🦊"])
        for _ in range(6):  # drain the real hub's token bucket (chat.action costs a token)
            await adapter.send_typing(chat)
        consumer.on_delta(", then the final")
        await asyncio.sleep(0.1)
        consumer.finish(full)
        await asyncio.wait_for(task, 20)
        assert ("message.edit", "rate_limited") in observed.codes or ("message.send", "rate_limited") in observed.codes
        await _assert_single_final(tight_hub, chat, sse, consumer, full)
    finally:
        await _stop(task, sse)


async def test_max_streams_refusal_streams_on_the_edit_transport_in_one_run(real, make_adapter):
    adapter, chat, sse = await _open_chat(real, make_adapter)
    adapter.MAX_STREAMS = 1
    assert await adapter.send_stream_frame("", chat_id=chat, turn_id="another-active-turn")
    consumer = _consumer(adapter, chat)
    task = asyncio.create_task(consumer.run())
    full = "refused native 🦊漢 then the end"
    try:
        consumer.on_delta("refused native 🦊漢 ")
        await _poll(lambda: _assistant(real, chat), lambda rows: rows)
        await asyncio.sleep(0.2)
        assert consumer._use_native_streaming is False, "the refused seed must fall back to send/edit"
        await _assert_open(real, chat, sse)
        consumer.on_delta("then the end")
        consumer.finish(full)
        await asyncio.wait_for(task, 10)
        await _assert_single_final(real, chat, sse, consumer, full)
    finally:
        await _stop(task, sse)


async def test_full_stream_cache_evicts_an_abandoned_idle_turn_instead_of_refusing(real, make_adapter):
    """A cancelled native turn never finalizes; it must not leave later turns without native streaming."""
    adapter, chat, sse = await _open_chat(real, make_adapter)
    adapter.MAX_STREAMS, adapter.STREAM_IDLE_EVICT = 1, 0.3
    assert await adapter.send_stream_frame("abandoned preview", chat_id=chat, turn_id="cancelled-turn")
    await asyncio.sleep(0.4)
    consumer = _consumer(adapter, chat)
    task = asyncio.create_task(consumer.run())
    full = "native again 🦊"
    try:
        consumer.on_delta(full)
        consumer.finish(full)
        await asyncio.wait_for(task, 10)
        assert consumer._use_native_streaming is True
        await _finished(sse, 10)
        assert await _assistant(real, chat) == ["abandoned preview", full]
        assert len(await real.runs(chat)) == 1 and consumer.delivered_final_matches(full) is True
    finally:
        await _stop(task, sse)


@pytest.mark.parametrize("outage", ["interim", "final"])
async def test_reconnect_longer_than_send_reconnect_wait_keeps_one_run_and_one_final(real, make_adapter, outage):
    adapter, chat, sse = await _open_chat(real, make_adapter)
    adapter.SEND_RECONNECT_WAIT = 0.2  # outage below lasts several times longer than every send wait
    gate, real_open = asyncio.Event(), adapter._open

    async def gated_open():  # DETERMINISTIC: the real socket stays down until the gate opens
        await gate.wait()
        return await real_open()

    consumer = _consumer(adapter, chat)
    task = asyncio.create_task(consumer.run())
    full = "before outage 🦊 during outage 漢 after outage"
    try:
        consumer.on_delta("before outage 🦊")
        await _poll(lambda: _assistant(real, chat), lambda rows: rows == ["before outage 🦊"])
        adapter._open = gated_open
        await adapter._conn.ws.close()
        await wait_for(lambda: adapter._conn is None)
        if outage == "interim":
            consumer.on_delta(" during outage 漢")
            await asyncio.sleep(3 * adapter.MAX_SEND_ATTEMPTS * adapter.SEND_RECONNECT_WAIT)
            await _assert_open(real, chat, sse)
            gate.set()
            await wait_for(lambda: adapter._conn is not None, timeout=5)
            consumer.on_delta(" after outage")
            consumer.finish(full)
            await asyncio.wait_for(task, 10)
            await _assert_single_final(real, chat, sse, consumer, full)
        else:
            consumer.finish(full)
            await asyncio.wait_for(task, 20)
            assert consumer.final_response_sent is False, "an undelivered final must not be reported as sent"
            await _assert_open(real, chat, sse)
            assert await _assistant(real, chat) == ["before outage 🦊"]
            gate.set()
            await wait_for(lambda: adapter._conn is not None, timeout=5)
            # the gateway's normal final send (real _send_with_retry) after the reconnect
            result = await adapter._send_with_retry(chat_id=chat, content=full, metadata={"notify": True})
            assert result.success
            await _finished(sse, 10)
            assert await _assistant(real, chat) == [full]
            runs = await real.runs(chat)
            assert len(runs) == 1 and runs[0]["state"] == "done" and sse.done
    finally:
        gate.set()
        await _stop(task, sse)
