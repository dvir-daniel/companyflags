// A backend that reads its flags with OpenFeature's server SDK and OFREP provider, with the api service's key.
//   GET /upload-limit?company=acme  →  { "company": "acme", "maxUploadMb": 1000, "reason": "TARGETING_MATCH", … }
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { OpenFeature } from '@openfeature/server-sdk';
import { OFREPProvider } from '@openfeature/ofrep-provider';

const baseUrl = process.env.FLAGS_URL ?? 'http://localhost:8787';
const key = process.env.FLAGS_API_KEY;
if (!key) {
  console.error('Set FLAGS_API_KEY to the api service’s key (see .env.example).');
  process.exit(1);
}

await OpenFeature.setProviderAndWait(new OFREPProvider({ baseUrl, headers: [['Authorization', `Bearer ${key}`]] }));
const flags = OpenFeature.getClient();

/** The visitor a % of devices is decided for: the signed-in user (?user=), else an ID kept in a cookie for this
 *  browser. Never one ID for everyone: then every anonymous visitor would land in the same group. */
function visitor(req: IncomingMessage, url: URL): { id: string; cookie?: string } {
  const user = url.searchParams.get('user');
  if (user) return { id: user };
  const saved = /(?:^|;\s*)visitor=([\w-]{1,64})/.exec(req.headers.cookie ?? '')?.[1];
  if (saved) return { id: saved };
  const id = randomUUID();
  return { id, cookie: `visitor=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax` };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  if (url.pathname !== '/upload-limit') return send(404, { error: 'try GET /upload-limit?company=acme' });

  // targetingKey is the device or user being decided for. The entity is named by its dimension, as the flag's rules
  // name it: { company: 'acme' }. Without one: everyone's value.
  const company = url.searchParams.get('company') ?? undefined;
  const who = visitor(req, url);
  const details = await flags.getNumberDetails('max_upload_mb', 100, {
    targetingKey: who.id,
    ...(company ? { company } : {}),
  });
  send(200, {
    company: company ?? null,
    maxUploadMb: details.value,
    reason: details.reason,
    variant: details.variant ?? null,
    // which publish answered, and which entity asked: what to look at when a value looks wrong
    revision: details.flagMetadata.revision ?? null,
    ...(details.errorCode ? { error: details.errorCode, message: details.errorMessage } : {}),
  }, who.cookie ? { 'set-cookie': who.cookie } : {});
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Listening: http://localhost:${port}/upload-limit?company=acme`));
