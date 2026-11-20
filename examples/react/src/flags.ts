import { OpenFeature } from '@openfeature/react-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';

/** An ID kept for this browser, so a % of devices keeps it in the same group. */
function deviceId() {
  const saved = localStorage.getItem('device-id');
  if (saved) return saved;
  const id = crypto.randomUUID();
  localStorage.setItem('device-id', id);
  return id;
}

export const APP_VERSION = '6.0.0';

/** Points OpenFeature at CompanyFlags over OFREP, with the web service's key (public). */
export async function startFlags() {
  const baseUrl = import.meta.env.VITE_FLAGS_URL ?? 'http://localhost:8787';
  const key = import.meta.env.VITE_FLAGS_KEY;
  if (!key) console.warn('Set VITE_FLAGS_KEY in .env.local (see .env.example): the page shows the defaults.');

  // What the browser knows about itself, and who signed in: the company, by its dimension.
  await OpenFeature.setContext({ targetingKey: deviceId(), app: { version: APP_VERSION }, company: 'acme' });
  OpenFeature.setProvider(new OFREPWebProvider({
    baseUrl,
    headers: [['Authorization', `Bearer ${key ?? ''}`]],
    pollInterval: 60_000,
  }));
}
