// A tiny OpenAI-compatible chat server for driving a REAL Hermes gateway without a model account.
// The last user message picks the behaviour: "slow ..." streams ~30 tokens over several seconds, "clarify ..." asks a
// clarifying question through Hermes's clarify tool, anything else answers "ok: <text>". Records every request.
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function fakeLlm({ tokenMs = 120 } = {}) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'fake-model', object: 'model' }] })); }
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end('{}'); }
    const b = JSON.parse(body || '{}'); log.push(b);
    const msgs = b.messages || [], last = msgs[msgs.length - 1] || {};
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (!b.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: 'fake-model', choices: [{ index: 0, message: { role: 'assistant', content: 'Title' }, finish_reason: 'stop' }] })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let closed = false; res.on('close', () => { closed = true; });
    const toolAsk = /clarif/i.test(msgs.filter((m) => m.role === 'user').map((m) => m.content).join(' ')) && last.role === 'user' && (b.tools || []).some((t) => t.function?.name === 'clarify');
    if (toolAsk) {
      res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'clarify', arguments: JSON.stringify({ questions: [{ question: 'Which environment?', choices: ['staging', 'production'] }] }) } }] }));
      res.write(chunk({}, 'tool_calls')); res.write('data: [DONE]\n\n'); return res.end();
    }
    const media = /\bsend-media (\S+)/.exec(text);
    if (media && last.role === 'user') { res.write(chunk({ role: 'assistant', content: '' })); res.write(chunk({ content: `Here is your file\nMEDIA:${media[1]}\n` })); res.write(chunk({}, 'stop')); res.write('data: [DONE]\n\n'); return res.end(); }
    const slow = /slow/i.test(text), n = slow ? 30 : 3;
    res.write(chunk({ role: 'assistant', content: '' }));
    const answerTo = last.role === 'tool' ? `got: ${text.slice(0, 60)}` : `ok: ${text.slice(0, 60)}`;
    for (let i = 0; i < n && !closed; i++) { res.write(chunk({ content: slow ? `w${i} ` : (i === 0 ? answerTo : '') })); if (slow) await sleep(tokenMs); }
    if (!closed) { res.write(chunk({}, 'stop')); res.write('data: [DONE]\n\n'); res.end(); }
  });
  return { log, server, listen: (port = 0) => new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port))), close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
if (process.argv[1].endsWith('fake-llm.js')) { const f = fakeLlm(); f.listen().then((p) => console.log(p)); }
