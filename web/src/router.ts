import { useEffect, useState } from 'preact/hooks';

export interface Route { name: string; params: URLSearchParams }
export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  return { name: path.split('/')[0] || 'agents', params: new URLSearchParams(query) };
}
export function navigate(name: string, params?: Record<string, string>) {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  location.hash = `#/${name}${q}`;
}
export function useRoute(): Route {
  const [r, set] = useState(() => parseRoute(location.hash));
  useEffect(() => { const on = () => set(parseRoute(location.hash)); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  return r;
}
