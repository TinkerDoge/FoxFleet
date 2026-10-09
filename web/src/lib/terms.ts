// Terms of Use / Privacy Policy acceptance. The hub records version + time on account creation; the browser also
// remembers locally which version it accepted for which hub, so the checkbox is pre-ticked only for that hub and version.
export const DOCS = 'https://tinkerdoge.github.io/FoxFleet/legal/';
export const TERMS_URL = DOCS + 'terms', PRIVACY_URL = DOCS + 'privacy', AGREEMENT_URL = DOCS + 'user-agreement';
export const FALLBACK_VERSION = '1.0';
const key = (hub: string) => `foxfleet.terms.${hub}`;
type Store = Pick<Storage, 'getItem' | 'setItem'>;
export const termsAccepted = (hub: string, version: string, store: Store = localStorage): boolean => { try { return store.getItem(key(hub)) === version; } catch { return false; } };
export function rememberTerms(hub: string, version: string, store: Store = localStorage): void { try { store.setItem(key(hub), version); } catch { /* private mode: the hub still has the record */ } }
