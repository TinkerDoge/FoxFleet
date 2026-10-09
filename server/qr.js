// Minimal QR encoder (byte mode, ECC level L, versions 1-5, single block): enough for a hub pairing link
// (<= 106 bytes). Dependency-free so the hub can render the code for the web page and the admin screen.
const VERS = [null, { n: 21, data: 19, ecc: 7, align: [] }, { n: 25, data: 34, ecc: 10, align: [6, 18] }, { n: 29, data: 55, ecc: 15, align: [6, 22] }, { n: 33, data: 80, ecc: 20, align: [6, 26] }, { n: 37, data: 108, ecc: 26, align: [6, 30] }];
const EXP = new Array(512), LOG = new Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function rs(data, n) {
  let gen = [1]; for (let i = 0; i < n; i++) { const next = new Array(gen.length + 1).fill(0); gen.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); }); gen = next; }
  const res = new Array(n).fill(0);
  for (const d of data) { const f = d ^ res.shift(); res.push(0); gen.slice(1).forEach((c, i) => { res[i] ^= mul(c, f); }); }
  return res;
}
function bits(text, v) {
  const bytes = [...Buffer.from(text, 'utf8')], cap = VERS[v].data, out = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) out.push((val >> i) & 1); };
  put(4, 4); put(bytes.length, 8); bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, cap * 8 - out.length)); while (out.length % 8) out.push(0);
  const cw = []; for (let i = 0; i < out.length; i += 8) cw.push(parseInt(out.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; cw.length < cap; pad ^= 0xec ^ 0x11) cw.push(pad);
  return cw.concat(rs(cw, VERS[v].ecc));
}
const MASKS = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];
function formatBits(mask) { // ECC L = 01
  const data = (1 << 3) | mask; let rem = data; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537); return ((data << 10) | rem) ^ 0x5412;
}
function build(text, v, mask) {
  const { n, align } = VERS[v], m = Array.from({ length: n }, () => new Array(n).fill(null)), fn = Array.from({ length: n }, () => new Array(n).fill(false));
  const set = (r, c, val, f = true) => { if (r >= 0 && c >= 0 && r < n && c < n) { m[r][c] = val; if (f) fn[r][c] = true; } };
  const finder = (r0, c0) => { for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) set(r0 + r, c0 + c, r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))); };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  if (align.length) { const a = align[1]; for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) set(a + r, a + c, Math.max(Math.abs(r), Math.abs(c)) !== 1); }
  set(n - 8, 8, true);
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, false); if (!fn[i][8]) set(i, 8, false); } for (let i = 0; i < 8; i++) { set(8, n - 1 - i, false); set(n - 1 - i, 8, false); }
  set(n - 8, 8, true);
  const cw = bits(text, v), stream = []; cw.forEach((b) => { for (let i = 7; i >= 0; i--) stream.push((b >> i) & 1); });
  let k = 0, up = true;
  for (let c = n - 1; c > 0; c -= 2) { if (c === 6) c--; for (let i = 0; i < n; i++) { const r = up ? n - 1 - i : i; for (const cc of [c, c - 1]) if (!fn[r][cc]) { const bit = k < stream.length ? stream[k++] : 0; m[r][cc] = Boolean(bit) !== MASKS[mask](r, cc); } } up = !up; }
  const f = formatBits(mask), bit = (i) => ((f >> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i); m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8); for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) m[8][n - 1 - i] = bit(i); for (let i = 8; i < 15; i++) m[n - 15 + i][8] = bit(i);
  m[n - 8][8] = true;
  return m;
}
function penalty(m) {
  const n = m.length; let p = 0;
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) { let run = 1; for (let j = 1; j < n; j++) { const a = pass ? m[j][i] : m[i][j], b = pass ? m[j - 1][i] : m[i][j - 1]; if (a === b) run++; else { if (run >= 5) p += run - 2; run = 1; } } if (run >= 5) p += run - 2; }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) p += 3;
  const dark = m.flat().filter(Boolean).length; p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return p;
}
export function qrMatrix(text) {
  const len = Buffer.byteLength(text); const v = [1, 2, 3, 4, 5].find((x) => VERS[x].data - 3 >= len);
  if (!v) throw new Error('Text too long for the built-in QR encoder (max 105 bytes)');
  let best, score = Infinity; for (let mask = 0; mask < 8; mask++) { const m = build(text, v, mask), s = penalty(m); if (s < score) { score = s; best = m; } }
  return best;
}
export function qrSvg(text, { scale = 8, quiet = 4 } = {}) {
  const m = qrMatrix(text), n = m.length, size = (n + quiet * 2) * scale; let path = '';
  m.forEach((row, r) => row.forEach((on, c) => { if (on) path += `M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
// Same matrix as rows of '1'/'0' characters, for clients that draw the code themselves; null when too long.
export function qrRows(text) { try { return qrMatrix(text).map((r) => r.map((x) => (x ? '1' : '0')).join('')); } catch { return null; } }
