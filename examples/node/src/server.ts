// A backend that reads its flags with OpenFeature's server SDK and OFREP provider, with the api service's key.
//   GET /upload-limit?company=acme  →  { "company": "acme", "maxUploadMb": 1000, "reason": "TARGETING_MATCH", … }
import { createServer } from 'node:http';
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname !== '/upload-limit') return send(404, { error: 'try GET /upload-limit?company=acme' });

  // The context names the company by its dimension, as the flag's rules do. Without it: everyone's value.
  const company = url.searchParams.get('company') ?? undefined;
  const details = await flags.getNumberDetails('max_upload_mb', 100, {
    targetingKey: url.searchParams.get('user') ?? 'anonymous',
    ...(company ? { company } : {}),
  });
  send(200, {
    company: company ?? null,
    maxUploadMb: details.value,
    reason: details.reason,
    variant: details.variant ?? null,
    ...(details.errorCode ? { error: details.errorCode, message: details.errorMessage } : {}),
  });
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Listening: http://localhost:${port}/upload-limit?company=acme`));
