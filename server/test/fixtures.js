// Ephemeral, disposable Hermes fixture; never reads a real machine or hub config.
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { wsAccept, encodeFrame, frameParser } from '../ws.js';
const json = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
async function body(req) { let text = ''; for await (const c of req) text += c; return JSON.parse(text || '{}'); }
async function listen(server) { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
export async function mockHermes(t, options = {}) {
  const requests = [], bytes = Buffer.from([0, 255, 10, 20, 30, 60]); let logins = 0, expired = false;
  const dash = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://mock'); requests.push({ service: 'dashboard', method: req.method, path: u.pathname, query: u.searchParams });
    if (u.pathname === '/api/status') return json(res, options.badStatus || 200, options.malformedStatus ? {} : { version: 'fixture-1', gateway_running: true, active_sessions: options.profileSessions?.[u.searchParams.get('profile') || 'default'] ?? 2, auth_required: !options.noAuth });
    if (u.pathname === '/auth/password-login') { logins++; assert.equal((await body(req)).password, 'dashboard-secret'); return json(res, 200, { ok: true }, { 'Set-Cookie': `hermes_session=cookie-${logins}; HttpOnly` }); }
    const cookieNumber = Number(req.headers.cookie?.match(/hermes_session=cookie-(\d+)/)?.[1]);
    if (!options.noAuth && !(cookieNumber >= 1 && cookieNumber <= logins)) return json(res, 401, { error: 'private secret' });
    if (options.expireOnce && logins === 1 && !expired) { expired = true; return json(res, 401, {}); }
    await options.beforeDashboardResponse?.(req, u);
    if (u.pathname === '/api/sessions') return json(res, 200, { sessions: [{ id: 'sess-1', title: 'real session' }] });
    if (u.pathname === '/api/sessions/search') return json(res, 200, { sessions: u.searchParams.get('q') === 'missing' ? [] : [{ id: 'sess-1' }] });
    if (/^\/api\/sessions\/[^/]+\/messages$/.test(u.pathname)) return json(res, options.noDashboardMessages ? 404 : 200, { messages: options.messages || [{ role: 'assistant', content: 'Files: `/outputs/result.png` and /outputs/report.html and /outputs/icon.svg and /outputs/notes.txt and /outputs/movie.mp4 and /outputs/archive.bin and /outputs/.env and /outputs/../secret.txt. /outputs/notes.txt.backup [Report](outputs/Launch plan.md)' }] });
    if (u.pathname === '/api/skills/toggle') { requests.at(-1).body = await body(req); return json(res, req.method === 'PUT' ? 200 : 405, { ok: true }); }
    if (u.pathname === '/api/config') return json(res, 200, { config: { model: 'visible', api_key: 'different-secret', nested: { password: 'hidden', note: 'Bearer hidden-token' }, command: 'API_SERVER_KEY=another-secret' } });
    if (u.pathname === '/api/logs') return json(res, 200, { logs: options.logs || [{ msg: 'dashboard-secret api-secret Authorization: Bearer surprise-token password=private-value' }] });
    if (u.pathname === '/api/analytics/usage') return json(res, 200, { input_tokens: 12, output_tokens: 14, total_tokens: 26, token: 'private-usage-token' });
    if (u.pathname === '/api/fs/download') {
      if (options.fileStatus) return json(res, options.fileStatus, { detail: 'private upstream secret' });
      if (options.denyFile) return json(res, 403, { detail: 'private /config secret' });
      const file = u.searchParams.get('path'); requests.at(-1).range = req.headers.range;
      requests.at(-1).acceptEncoding = req.headers['accept-encoding'];
      if (options.gzipFile) { const compressed = gzipSync(bytes); res.writeHead(req.headers.range ? 206 : 200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length, ...(req.headers.range ? { 'Content-Range': 'bytes 0-2/6', 'Accept-Ranges': 'bytes' } : {}) }); return res.end(compressed); }
      if (options.files?.[file]) { const entry = options.files[file]; res.writeHead(200, { 'Content-Type': entry.mime || 'application/octet-stream' }); return res.end(entry.bytes); }
      if (file.endsWith('.txt')) return res.end(options.largeText ? 'x'.repeat(600_000) : 'hello');
      if (file.endsWith('.html')) return res.end('<script>alert(1)</script>');
      if (file.endsWith('.svg')) return res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': 'image/png', ...(req.headers.range ? { 'Content-Range': 'bytes 0-2/6', 'Accept-Ranges': 'bytes' } : {}) }); return res.end(req.headers.range ? bytes.subarray(0, 3) : bytes);
    }
    if (u.pathname === '/api/auth/ws-ticket' && req.method === 'POST') return json(res, 200, { ticket: 'gw-ticket-' + logins, ttl_seconds: 30 });
    if (u.pathname === '/api/files/upload-stream' && req.method === 'POST') { const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks); requests.at(-1).contentType = req.headers['content-type']; requests.at(-1).raw = raw; const p = raw.toString('utf8').match(/name="path"\r\n\r\n([^\r]*)/)?.[1]; return json(res, options.uploadStatus || 200, { ok: true, path: (p || '').replace(/^~/, '/home/agent'), entry: {} }); }
    if (u.pathname === '/api/audio/transcribe' && req.method === 'POST') { requests.at(-1).body = await body(req); return json(res, 200, { ok: true, transcript: 'xin chào hello', provider: 'local' }); }
    if (u.pathname === '/api/cron/jobs') return json(res, 200, { jobs: options.jobs || [{id:'daily',name:'Daily briefing',schedule:'0 8 * * *',enabled:true,paused:false}] });
    if (u.pathname === '/api/skills') return json(res, 200, { skills: options.skills || [{name:'web-search',description:'Search documentation',enabled:true}] });
    if (u.pathname === '/api/profiles') return json(res, 200, { profiles: options.profiles || [{name:'default'}] });
    if (/^\/api\/cron\/jobs\/.+\/(pause|resume|trigger)$/.test(u.pathname)) return json(res, 200, { action: u.pathname.split('/').at(-1) });
    return json(res, 404, {});
  });
  const api = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://mock'), route = u.pathname.replace(/^\/p\/[^/]+/, '');
    requests.push({ service: 'api', method: req.method, path: u.pathname, authorization: req.headers.authorization, session: req.headers['x-hermes-session-id'] });
    if (req.headers.authorization !== 'Bearer api-secret') return json(res, 401, { error: 'secret' });
    if (route === '/v1/capabilities') {
      if (options.hangApi) return;
      if (options.redirectApi) { res.writeHead(302, { Location: options.redirectApi }); return res.end(); }
      return json(res, options.apiStatus || (options.legacy ? 404 : 200), options.malformedCapabilities ? { features: 'invalid' } : { object: 'hermes.api_server.capabilities', features: { chat_completions: !options.noChat, session_messages: true, ...options.features } });
    }
    if (options.apiRoute && await options.apiRoute(req, res, route, u)) return; // tests plug in a fake Hermes /v1/runs here
    if (route === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'hermes-agent', object: 'model' }] });
    if (/^\/api\/sessions\/[^/]+\/messages$/.test(route)) return json(res, 200, { messages: [{ role: 'assistant', content: '/outputs/result.png' }] });
    if (route === '/v1/chat/completions') {
      requests.at(-1).body = await body(req); res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Hermes-Session-Id': 'sess-1' });
      if (options.streamFrames) {
        let cancelled=false;res.on('close',()=>{cancelled=true;});
        for (const frame of options.streamFrames) { if(cancelled)return;res.write(frame);await new Promise(resolve=>setTimeout(resolve,options.streamDelayMs || 30)); }
        if(!cancelled)res.end('data: [DONE]\r\n\r\n');return;
      }
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      if (options.slowStream) { const timer = setInterval(() => res.write('data: {"choices":[]}\n\n'), 10); res.on('close', () => { clearInterval(timer); options.onStreamClose?.(); }); return; }
      return res.end('data: [DONE]\n\n');
    }
    return json(res, 404, {});
  });
  const upgraded = new Set();
  if (options.onUpgrade) dash.on('upgrade', (req, socket, head) => { upgraded.add(socket); socket.on('close', () => upgraded.delete(socket)); options.onUpgrade(req, socket, head); });
  const db = await listen(dash), ab = await listen(api); const dispose = async () => { for (const s of upgraded) s.destroy(); await close(dash); await close(api); }; t?.after(dispose);
  return { dispose, requests, bytes, get logins() { return logins; }, connection: { name: 'fixture', host: '127.0.0.1', dashboardPort: Number(new URL(db).port), apiServerPort: Number(new URL(ab).port), dashboardUser: 'admin', dashboardPass: 'dashboard-secret', apiServerKey: 'api-secret' } };
}

export function fakeDashboard(log) {
  return (req, socket) => {
    const u = new URL(req.url, 'http://mock');
    log.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), origin: req.headers.origin });
    if (u.pathname === '/api/ws') {
      if (!u.searchParams.get('ticket')?.startsWith('gw-ticket-')) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      const ws = wsAccept(req, socket);
      ws.on('message', (text) => {
        const msg = JSON.parse(text); log.push({ rpc: msg.method, params: msg.params });
        const status = { profile: msg.params.profile, supported: true, installed: true, running: true, geometry: '1280x800', lease: { holder: 'agent', epoch: 1, since: 1 } };
        const result = { 'display.status': status, 'display.start': status, 'display.observe': { ...status, ticket: 'display-ticket-1', path: '/api/display/ws', viewer_id: 'viewer-1' }, 'display.lease.acquire': { lease: { holder: 'human', epoch: 2 } }, 'display.lease.release': { lease: { holder: 'agent', epoch: 3 } } }[msg.method];
        ws.send(JSON.stringify(result ? { jsonrpc: '2.0', id: msg.id, result } : { jsonrpc: '2.0', id: msg.id, error: { code: 5300, message: 'nope' } }));
      });
      return;
    }
    if (u.pathname === '/api/display/ws') {
      const ws = wsAccept(req, socket);
      if (u.searchParams.get('display_ticket') !== 'display-ticket-1') return ws.close(4401);
      ws.sendBinary(Buffer.from('RFB 003.008\n'));
      ws.on('binary', (data) => ws.sendBinary(Buffer.concat([Buffer.from('echo:'), data])));
      return;
    }
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  };
}
export function rawClient(base, route, headers) {
  // Masked client frames, raw socket (the noVNC side of the hub).
  return new Promise((resolve, reject) => {
    const u = new URL(route, base);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('upgrade', (res, socket, head) => { const parse = frameParser(); const frames = []; if (head?.length) frames.push(...parse(head)); socket.on('data', (c) => frames.push(...parse(c))); resolve({ status: 101, socket, frames, accept: res.headers['sec-websocket-accept'] }); });
    req.on('error', reject); req.end();
  });
}

