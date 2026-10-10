// Reasoning normalisation for the hub: whatever a model or provider calls its thinking, clients see ONE shape: choices[0].delta.reasoning_content,
// and never inside the visible reply (delta.content). Handles <think>/<thinking> tags in the text (OpenAI-compatible servers, OpenRouter, Z.ai/GLM,
// DeepSeek-style), and the field names `reasoning`, `reasoning_text`, `thinking` that providers use instead of `reasoning_content`.
// contract/reasoning.vectors.json holds the cases; the web and Android clients only ever read reasoning_content.
const TAGS = [['<think>', '</think>'], ['<thinking>', '</thinking>']];
const OPEN = TAGS.map((t) => t[0]), maxOpen = Math.max(...OPEN.map((o) => o.length)), maxClose = Math.max(...TAGS.map((t) => t[1].length));

/** Streaming splitter: feed text chunks, get { content, reasoning } back; a tag cut across two chunks is held back until it is complete. */
export function thinkSplitter() {
  let inside = null, buf = '', skipNl = false;
  const holdLen = (s, tags) => { // how many trailing chars could still become the start of one of `tags`
    for (let n = Math.min(s.length, Math.max(...tags.map((t) => t.length)) - 1); n > 0; n--) if (tags.some((t) => t.startsWith(s.slice(-n)))) return n;
    return 0;
  };
  function run(final) {
    let content = '', reasoning = '';
    for (;;) {
      if (!inside) {
        if (skipNl) { buf = buf.replace(/^\n+/, ''); if (buf) skipNl = false; }
        let at = -1, tag = null;
        for (const t of TAGS) { const i = buf.indexOf(t[0]); if (i >= 0 && (at < 0 || i < at)) { at = i; tag = t; } }
        if (at >= 0) { content += buf.slice(0, at); buf = buf.slice(at + tag[0].length); inside = tag; continue; }
        const keep = final ? 0 : holdLen(buf, OPEN); content += buf.slice(0, buf.length - keep); buf = buf.slice(buf.length - keep); break;
      }
      const i = buf.indexOf(inside[1]);
      if (i >= 0) { reasoning += buf.slice(0, i); buf = buf.slice(i + inside[1].length); inside = null; skipNl = true; continue; } // the newlines models put after </think> are not part of the reply
      const keep = final ? 0 : holdLen(buf, [inside[1]]); reasoning += buf.slice(0, buf.length - keep); buf = buf.slice(buf.length - keep); break;
    }
    return { content, reasoning };
  }
  return { push(text) { buf += String(text ?? ''); return run(false); }, flush() { return run(true); }, get inside() { return Boolean(inside); } };
}

/** One parsed chat-completions chunk -> the same chunk in the normal shape (mutates a copy). `split` is the stream's thinkSplitter. */
export function normaliseChunk(obj, split) {
  const choice = obj?.choices?.[0]; const d = choice?.delta ?? choice?.message; if (!d || typeof d !== 'object') return obj;
  const out = { ...obj, choices: [{ ...choice, [choice.delta ? 'delta' : 'message']: { ...d } }, ...obj.choices.slice(1)] }, nd = out.choices[0][choice.delta ? 'delta' : 'message'];
  let reasoning = '';
  for (const k of ['reasoning_content', 'reasoning', 'reasoning_text', 'thinking']) { if (typeof nd[k] === 'string') { reasoning += nd[k]; if (k !== 'reasoning_content') delete nd[k]; } else if (k === 'reasoning' && nd[k] && typeof nd[k] === 'object' && typeof nd[k].text === 'string') { reasoning += nd[k].text; delete nd[k]; } }
  if (typeof nd.content === 'string') { const s = split.push(nd.content); nd.content = s.content; reasoning += s.reasoning; }
  if (choice.finish_reason) { const f = split.flush(); if (typeof nd.content === 'string' || f.content) nd.content = (nd.content ?? '') + f.content; reasoning += f.reasoning; }
  if (reasoning) nd.reasoning_content = reasoning; else delete nd.reasoning_content;
  return out;
}

/** Wrap an SSE body so every data: chunk is normalised. Non-JSON and non-chat frames pass through untouched; a frame left empty by the split is dropped. */
export function normaliseSse(body) {
  const dec = new TextDecoder(), enc = new TextEncoder(), split = thinkSplitter(); let pending = '';
  const frame = (raw) => {
    const m = /^data: ?(.*)$/m.exec(raw); if (!m || m[1] === '[DONE]') return raw;
    let obj; try { obj = JSON.parse(m[1]); } catch { return raw; }
    if (!obj?.choices) return raw;
    const out = normaliseChunk(obj, split), d = out.choices[0]?.delta;
    if (d && typeof d === 'object' && !d.content && !d.reasoning_content && !d.tool_calls && !d.role && !out.choices[0].finish_reason && 'content' in d) return null; // held-back tag text: nothing to show yet
    return raw.replace(m[0], 'data: ' + JSON.stringify(out));
  };
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      pending += dec.decode(chunk, { stream: true }); let i;
      while ((i = pending.indexOf('\n\n')) >= 0) { const raw = pending.slice(0, i); pending = pending.slice(i + 2); const o = frame(raw); if (o !== null) ctl.enqueue(enc.encode(o + '\n\n')); }
    },
    flush(ctl) { if (pending) ctl.enqueue(enc.encode(pending)); },
  }));
}
