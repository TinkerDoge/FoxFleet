"""HTTP media stays off the socket; old hellos never upload or fetch images."""
import base64
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from gateway.config import PlatformConfig
from foxfleet import protocol, rooms
from foxfleet.adapter import FoxFleetAdapter, _Conn

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCWQAAAAASUVORK5CYII=')
MID = 'fbm_' + 'a' * 24
CHAT = 'fc_' + 'a' * 16
MSG = 'fm_' + 'b' * 16


@pytest.fixture
def adapter(monkeypatch):
    monkeypatch.setenv('FOXFLEET_BOT_TOKEN', 'ffb_' + 'T' * 43)
    a = FoxFleetAdapter(PlatformConfig(enabled=True, extra={'hub_url': 'http://127.0.0.1:9999'}))
    a._ws_url = 'ws://127.0.0.1:9999/api/bot/ws'
    hello = protocol.Hello('0123456789abcdef01234567', 0, 0, protocol.PROTOCOL_V11, frozenset({'media'}))
    a._conn = _Conn(SimpleNamespace(), hello, 1)
    a._conn.media_enabled = True
    a._request = AsyncMock(return_value=protocol.parse_res({'t': 'res', 'id': 'r1', 'ok': True, 'result': {'message_id': MSG}}))
    return a


def mock_http(monkeypatch, handler):
    client = httpx.AsyncClient

    def factory(**kwargs):
        assert kwargs.get("trust_env") is False
        assert kwargs.get("follow_redirects") is False
        return client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)


@pytest.mark.asyncio
async def test_local_upload_then_socket_ids_and_inbound_cache(adapter, monkeypatch, tmp_path):
    seen = []

    async def handler(request):
        assert request.headers['authorization'] == 'Bot ' + adapter._token
        seen.append(request)
        if request.method == 'POST':
            assert request.headers['x-foxfleet-chat'] == CHAT
            assert await request.aread() == PNG
            return httpx.Response(201, json={'media_id': MID})
        assert request.url.path == '/api/bot/media/' + MID
        return httpx.Response(200, content=PNG, headers={'Content-Type': 'application/octet-stream'})

    mock_http(monkeypatch, handler)
    file = tmp_path / 'picture.png'
    file.write_bytes(PNG)
    sent = await adapter.send_image_file(CHAT, str(file))
    assert sent.success and sent.message_id == MSG
    params = adapter._request.call_args.kwargs
    assert params['media'] == [MID] and params['text'] == ''
    frame = protocol.build_request('message.send', 'r1', **{k: v for k, v in params.items() if k != 'retry_unknown'})
    assert frame['media'] == [MID] and str(file) not in str(frame)
    paths = await adapter._download_media(adapter._conn, ({'id': MID, 'kind': 'image', 'mime': 'image/png', 'name': 'image.png', 'size': len(PNG)},))
    assert len(paths) == 1 and Path(paths[0]).is_file() and Path(paths[0]).read_bytes() == PNG
    assert not paths[0].startswith(('http', '/api/', '/bot-media/'))
    assert [r.method for r in seen] == ['POST', 'GET']


@pytest.mark.asyncio
@pytest.mark.parametrize('hook,argument', [('send_image_file', 'image_path'), ('send_document', 'file_path'), ('send_voice', 'audio_path'), ('send_video', 'video_path')])
async def test_over_cap_and_failed_upload_never_report_success(adapter, monkeypatch, tmp_path, hook, argument):
    file = tmp_path / 'media.png'
    file.write_bytes(PNG)
    adapter._conn.hello = protocol.Hello('0123456789abcdef01234567', 0, 0, max_media_bytes=1)
    assert not (await getattr(adapter, hook)(CHAT, **{argument: str(file)})).success
    adapter._request.assert_not_called()
    adapter._conn.hello = protocol.Hello('0123456789abcdef01234567', 0, 0)
    mock_http(monkeypatch, lambda request: httpx.Response(413))
    assert not (await getattr(adapter, hook)(CHAT, **{argument: str(file)})).success
    adapter._request.assert_not_called()


@pytest.mark.asyncio
async def test_denied_delivery_path_is_not_uploaded(adapter, monkeypatch):
    monkeypatch.setattr('gateway.platforms.base.validate_media_delivery_path', lambda path, session_key='': None)
    assert not (await adapter.send_document(CHAT, '/etc/hostname')).success
    adapter._request.assert_not_called()


@pytest.mark.asyncio
async def test_featureless_and_v1_do_not_upload_or_cache(adapter, monkeypatch):
    cache = AsyncMock(side_effect=AssertionError('must not fetch'))
    monkeypatch.setattr('gateway.platforms.base.cache_image_from_url', cache)
    adapter._conn.media_enabled = False
    adapter._upload_media = AsyncMock(side_effect=AssertionError('must not upload'))
    assert not (await adapter.send_image(CHAT, 'https://example.com/image.png')).success
    assert not (await adapter.send_animation(CHAT, 'https://example.com/image.gif')).success
    assert not (await adapter.send_multiple_images(CHAT, [('https://example.com/image.png', '')])).success
    assert not (await adapter.send_document(CHAT, '/missing')).success
    cache.assert_not_called()
    adapter._upload_media.assert_not_called()


@pytest.mark.asyncio
async def test_url_uses_hermes_cache_and_batch_uses_one_message(adapter, monkeypatch, tmp_path):
    file = tmp_path / 'media.png'
    file.write_bytes(PNG)
    cache = AsyncMock(return_value=str(file))
    monkeypatch.setattr('gateway.platforms.base.cache_image_from_url', cache)
    adapter._upload_media = AsyncMock(return_value=MID)
    assert (await adapter.send_image(CHAT, 'https://example.com/image.png')).success
    cache.assert_awaited_once_with('https://example.com/image.png')
    assert (await adapter.send_multiple_images(CHAT, [(file.as_uri(), 'first'), (file.as_uri(), 'second')])).success
    assert adapter._request.call_args.kwargs['media'] == [MID, MID]


@pytest.mark.asyncio
async def test_room_media_uses_group_upload_header_and_the_exact_attempt(adapter, monkeypatch, tmp_path):
    seen = []

    async def handler(request):
        seen.append(request)
        if request.method == 'POST':
            assert request.headers['x-foxfleet-chat'] == CHAT
            assert request.headers['x-foxfleet-chat-type'] == 'group'
            assert await request.aread() == PNG
            return httpx.Response(201, json={'media_id': MID})
        return httpx.Response(404)

    mock_http(monkeypatch, handler)
    adapter._conn.groups_enabled = True
    file = tmp_path / 'picture.png'
    file.write_bytes(PNG)
    turn = rooms.RoomTurn(chat_id=CHAT, thread_id='fcr_' + 'c' * 16,
                          dispatch_id='fd_' + 'd' * 16, run_token='attempt-token')
    with rooms.bind_turn(turn):
        sent = await adapter.send_image_file(CHAT, str(file), caption='')
    assert sent.success and sent.message_id == MSG
    params = adapter._request.call_args.kwargs
    assert params['media'] == [MID]
    assert params['dispatch_id'] == 'fd_' + 'd' * 16
    assert params['run_token'] == 'attempt-token'
    assert 'thread_id' not in params
    assert [r.method for r in seen] == ['POST']


@pytest.mark.asyncio
async def test_room_dispatch_accepts_a_file_attachment_and_non_image_downloads(adapter, monkeypatch):
    payload = b'PK\x03\x04archive-bytes'
    frame = {'t': 'dispatch.run', 'dispatch_id': 'fd_' + 'd' * 16, 'run_token': 'tok',
             'chat_id': CHAT, 'thread_id': 'fcr_' + 'c' * 16, 'message_id': MSG,
             'actor': {'kind': 'human', 'id': 'u1', 'name': 'Owner', 'is_bot': False},
             'mentions': [], 'text': 'archive', 'date': 1,
             'media': [{'id': MID, 'kind': 'file', 'mime': 'application/zip', 'name': 'archive.zip', 'size': len(payload)}]}
    dispatch = protocol.parse_dispatch(frame)
    assert dispatch.media[0]['id'] == MID

    def handler(request):
        assert request.url.path == '/api/bot/media/' + MID
        return httpx.Response(200, content=payload, headers={'Content-Type': 'application/octet-stream'})

    mock_http(monkeypatch, handler)
    paths = await adapter._download_media(adapter._conn, dispatch.media)
    assert len(paths) == 1 and Path(paths[0]).read_bytes() == payload


def test_media_metadata_validation():
    frame = {'t': 'message.new', 'event_id': 1, 'chat_id': CHAT, 'chat_type': 'dm', 'message_id': MSG,
             'user': {'id': 'u1'}, 'text': '', 'media': [{'id': MID, 'kind': 'image', 'mime': 'image/png', 'name': 'image.png', 'size': len(PNG)}]}
    assert protocol.parse_message_new(frame).media[0]['id'] == MID
    for bad in ('https://evil.test/image', '../secret', '/home/secret'):
        frame['media'][0]['id'] = bad
        with pytest.raises(protocol.ProtocolError):
            protocol.parse_message_new(frame)
