import { useEffect, useState } from 'preact/hooks';

export interface Route { name: string; params: URLSearchParams }
export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  return { name: path.split('/')[0] || 'agents', params: new URLSearchParams(query) };
}
export function navigate(name: string, params?: Record<string, string>, replace = false) {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  const hash = `#/${name}${q}`;
  if (location.hash === hash) return;
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
  // Keep route consumers in step with explicit selections before the browser's deferred hash event.
  dispatchEvent(new Event('hashchange'));
}
export function useRoute(): Route {
  const [r, set] = useState(() => parseRoute(location.hash));
  useEffect(() => { const on = () => set(parseRoute(location.hash)); addEventListener('hashchange', on); addEventListener('popstate', on); return () => { removeEventListener('hashchange', on); removeEventListener('popstate', on); }; }, []);
  return r;
}
