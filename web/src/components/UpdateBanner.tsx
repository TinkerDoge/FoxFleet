import { useEffect, useState } from 'preact/hooks';
import { registerSw } from '../pwa';
import { t } from '../i18n/t';

export function UpdateBanner() {
  const [apply, setApply] = useState<(() => void) | null>(null);
  useEffect(() => { registerSw((fn) => setApply(() => fn)); }, []);
  if (!apply) return null;
  return <div class="update-banner" role="status"><span>{t('pwa.update')}</span><button class="btn primary inline" onClick={apply}>{t('pwa.reload')}</button></div>;
}
