// Version label of the Terms of Use / Privacy Policy text (site/legal/*.md, TERMS.md, PRIVACY.md).
// Bump it whenever those texts change materially; clients then ask people to accept again.
import { fault } from './config.js';

export const TERMS_VERSION = '1.0';

// `acceptedTerms` is optional on setup/register (older clients omit it). When present it must be a short version label.
export function acceptedTerms(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[0-9A-Za-z._-]{1,32}$/.test(value)) throw fault(400, 'Invalid terms version');
  return value;
}
