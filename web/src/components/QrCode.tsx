/** Draws the hub-generated QR matrix (rows of '1'/'0') as an SVG; high contrast on white with a 3-module quiet zone. */
export function QrCode({ rows, label, size = 208 }: { rows: string[]; label: string; size?: number }) {
  const n = rows.length, quiet = 3, dim = n + quiet * 2;
  const path = rows.map((row, y) => [...row].map((c, x) => (c === '1' ? `M${x + quiet} ${y + quiet}h1v1h-1z` : '')).join('')).join('');
  return <svg class="qr" width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} role="img" aria-label={label} shape-rendering="crispEdges"><rect width={dim} height={dim} fill="#fff" /><path d={path} fill="#000" /></svg>;
}
