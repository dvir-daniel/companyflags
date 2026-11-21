// AWS without its SDK, for the cloudfront plugin (plugins/cloudfront.ts): Signature Version 4, and the credentials
// the SDK's default chain would find. Nothing is stored: the keys come from the environment, the container's
// credentials endpoint (ECS task role, EKS Pod Identity), a web identity token (EKS IRSA) or the instance's metadata
// (EC2, IMDSv2), and the ones that expire are kept in memory until shortly before they do.

import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date };

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s, 'utf8').digest();
/** RFC 3986 encoding, as SigV4 wants it: everything but A–Z a–z 0–9 - . _ ~ is %XX. */
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A request, signed with SigV4 for `service` in `region` at `now`: its headers, with x-amz-date, the session token if
 *  any, and authorization. `host` is signed but left out of what's returned (fetch sets it from the URL). */
export function signV4(
  req: { method: string; url: string; headers?: Record<string, string>; body?: string },
  creds: AwsCredentials,
  where: { region: string; service: string },
  now: Date = new Date(),
): Record<string, string> {
  const url = new URL(req.url);
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
  headers['x-amz-date'] = amzDate;
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  const signing: Record<string, string> = { ...headers, host: url.host };
  const names = Object.keys(signing).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signing[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  // every service but S3 encodes each path segment twice: once as the URL has it, once more here
  const path =
    url.pathname
      .split('/')
      .map((seg) => encode(decodeURIComponent(seg)))
      .map(encode)
      .join('/') || '/';
  const query = [...url.searchParams]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [req.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, sha256(req.body ?? '')].join('\n');
  const scope = `${day}/${where.region}/${where.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), where.region), where.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

export class AwsCredentialsError extends Error {}

/** Credentials are fetched again this long before they expire. */
export const REFRESH_BEFORE_MS = 5 * 60_000;
/** How long one call for credentials may take: the instance's metadata answers at once on EC2, and nowhere else. */
const CREDENTIALS_TIMEOUT_MS = 2000;
const IMDS = 'http://169.254.169.254';
/** The addresses AWS_CONTAINER_CREDENTIALS_FULL_URI may name over plain HTTP, as the SDK allows: the ECS and EKS
 *  credential agents, and this machine. Anything else must be HTTPS. */
const CONTAINER_HOSTS = new Set(['169.254.170.2', '169.254.170.23', '[fd00:ec2::23]', 'localhost', '[::1]']);

export type CredentialChainOptions = {
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  /** Reads a token file (AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE, AWS_WEB_IDENTITY_TOKEN_FILE): node's readFile unless a
   *  test hands another. */
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
};

/** The credentials, first found: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (with AWS_SESSION_TOKEN); a web identity
 *  token (AWS_WEB_IDENTITY_TOKEN_FILE and AWS_ROLE_ARN, EKS IRSA); the container's endpoint
 *  (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, or _FULL_URI with AWS_CONTAINER_AUTHORIZATION_TOKEN[_FILE]); else the
 *  instance's metadata (IMDSv2) unless AWS_EC2_METADATA_DISABLED. The first one set up is the one used: if it fails,
 *  that's the error, as with the SDK. Ones that expire are kept until REFRESH_BEFORE_MS before they do. */
export function credentialChain(o: CredentialChainOptions): () => Promise<AwsCredentials> {
  const read = o.readFile ?? ((p: string) => readFile(p, 'utf8'));
  const now = o.now ?? Date.now;
  let cached: AwsCredentials | null = null;
  let pending: Promise<AwsCredentials> | null = null;

  const get = async (url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response> => {
    const res = await o.fetch(url, { method, headers, signal: AbortSignal.timeout(CREDENTIALS_TIMEOUT_MS) });
    if (!res.ok) throw new AwsCredentialsError(`${new URL(url).host} said ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  };
  type Answer = { AccessKeyId?: string; SecretAccessKey?: string; Token?: string; Expiration?: string };
  const fromJson = (j: Answer, where: string): AwsCredentials => {
    if (!j.AccessKeyId || !j.SecretAccessKey) throw new AwsCredentialsError(`${where} gave no credentials`);
    return {
      accessKeyId: j.AccessKeyId,
      secretAccessKey: j.SecretAccessKey,
      sessionToken: j.Token || undefined,
      expiration: j.Expiration ? new Date(j.Expiration) : undefined,
    };
  };

  async function container(): Promise<AwsCredentials> {
    const env = o.env;
    let url: string;
    const headers: Record<string, string> = {};
    if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
      url = `http://169.254.170.2${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`;
    } else {
      url = env.AWS_CONTAINER_CREDENTIALS_FULL_URI!;
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new AwsCredentialsError('AWS_CONTAINER_CREDENTIALS_FULL_URI isn’t a URL');
      }
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (CONTAINER_HOSTS.has(u.hostname) || /^127\./.test(u.hostname)))) {
        throw new AwsCredentialsError(
          `AWS_CONTAINER_CREDENTIALS_FULL_URI must be HTTPS, or HTTP to the ECS or EKS credential agent or this machine (not ${u.host})`,
        );
      }
      const token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
        ? (await read(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE)).trim()
        : env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
      if (token) headers.authorization = token;
    }
    return fromJson((await (await get(url, headers)).json()) as Answer, 'the container’s credentials endpoint');
  }

  async function webIdentity(): Promise<AwsCredentials> {
    const env = o.env;
    const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
    const token = (await read(env.AWS_WEB_IDENTITY_TOKEN_FILE!)).trim();
    const body = new URLSearchParams({
      Action: 'AssumeRoleWithWebIdentity',
      Version: '2011-06-15',
      RoleArn: env.AWS_ROLE_ARN!,
      RoleSessionName: env.AWS_ROLE_SESSION_NAME || `companyflags-${now()}`,
      WebIdentityToken: token,
    });
    const res = await o.fetch(region ? `https://sts.${region}.amazonaws.com/` : 'https://sts.amazonaws.com/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(CREDENTIALS_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new AwsCredentialsError(`STS said ${res.status}: ${xmlText(text, 'Message') ?? text.slice(0, 200)}`);
    // STS answers XML (or JSON, from a stand-in that speaks it: read either)
    let c: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: string | number } | undefined;
    try {
      c = JSON.parse(text)?.AssumeRoleWithWebIdentityResponse?.AssumeRoleWithWebIdentityResult?.Credentials;
    } catch {
      c = {
        AccessKeyId: xmlText(text, 'AccessKeyId'),
        SecretAccessKey: xmlText(text, 'SecretAccessKey'),
        SessionToken: xmlText(text, 'SessionToken'),
        Expiration: xmlText(text, 'Expiration'),
      };
    }
    const expiration = typeof c?.Expiration === 'number' ? new Date(c.Expiration * 1000).toISOString() : c?.Expiration;
    return fromJson({ AccessKeyId: c?.AccessKeyId, SecretAccessKey: c?.SecretAccessKey, Token: c?.SessionToken, Expiration: expiration }, 'STS');
  }

  async function instance(): Promise<AwsCredentials> {
    let token: string;
    try {
      token = await (await get(`${IMDS}/latest/api/token`, { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' }, 'PUT')).text();
    } catch (e) {
      throw new AwsCredentialsError(
        `no AWS credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or run with a task role, a pod identity or an instance profile (the instance’s metadata didn’t answer: ${(e as Error).message})`,
      );
    }
    const h = { 'x-aws-ec2-metadata-token': token };
    const role = (await (await get(`${IMDS}/latest/meta-data/iam/security-credentials/`, h)).text()).split('\n')[0].trim();
    if (!role) throw new AwsCredentialsError('the instance has no IAM role (instance profile)');
    return fromJson(
      (await (await get(`${IMDS}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`, h)).json()) as Answer,
      'the instance’s metadata',
    );
  }

  async function find(): Promise<AwsCredentials> {
    const env = o.env;
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined };
    }
    if (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) return webIdentity();
    if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI) return container();
    if (env.AWS_EC2_METADATA_DISABLED?.toLowerCase() === 'true') {
      throw new AwsCredentialsError('no AWS credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or run with a task role or a pod identity');
    }
    return instance();
  }

  return async () => {
    if (cached && (!cached.expiration || cached.expiration.getTime() - REFRESH_BEFORE_MS > now())) return cached;
    // one call at a time: purges at once share it
    pending ??= find()
      .then((c) => {
        cached = c;
        return c;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

/** The text of the first <name>…</name> in an XML answer (AWS's errors and STS's credentials), unescaped. */
export function xmlText(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m
    ? m[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
    : undefined;
}

/** Text for an XML element's content. */
export const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
