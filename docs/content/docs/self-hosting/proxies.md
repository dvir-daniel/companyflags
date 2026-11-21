---
title: "Proxies and HTTPS"
description: "Put a proxy or load balancer in front: TLS, the console's address, client addresses, timeouts, and which paths to expose."
---

Every install needs something in front of the server. The server speaks plain HTTP on port 8787 (`PORT`), so a proxy
or load balancer ends TLS, and the console is served only over `https`. This page sets that up on one machine, then
says what any proxy, load balancer or CDN must do.

## A proxy on the same server

Add the proxy to the [Compose setup](/self-hosting/docker#docker-compose-with-postgres) with a file named
`docker-compose.override.yml` beside `docker-compose.yml`. Compose reads both. The proxy reaches the server over
Compose's network, and the server's own port stays on `127.0.0.1`.

Each override pins the Compose network's subnet, so the server can trust the proxy's address. Each one:

- ends TLS and adds HSTS (the server sends no `Strict-Transport-Security` header);
- sends the client's address in `X-Forwarded-For`;
- doesn't buffer answers, so the change-event streams flow;
- keeps a read timeout above 120 seconds, for the streams;
- lets bodies of 4 MB through, for imports.

First, the proxy's own config, beside `docker-compose.yml`. Caddy gets a certificate by itself, sets
`X-Forwarded-For`, and has no read timeout by default. nginx needs your certificate in `./certs`.

```text tab="Caddy"
# Caddyfile
flags.example.com {
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	request_body {
		max_size 4MB
	}
	reverse_proxy companyflags:8787 {
		flush_interval -1
	}
}
```

```nginx tab="nginx"
# nginx.conf
server {
  listen 80;
  server_name flags.example.com;
  return 301 https://$host$request_uri;
}
server {
  listen 443 ssl;
  http2 on;
  server_name flags.example.com;
  ssl_certificate     /etc/nginx/certs/fullchain.pem;
  ssl_certificate_key /etc/nginx/certs/privkey.pem;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  client_max_body_size 4m;
  location / {
    proxy_pass http://companyflags:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 300s;
  }
}
```

Then the override, which starts the proxy and pins the subnet:

```yaml tab="Caddy"
# docker-compose.override.yml
services:
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443", "443:443/udp"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy:/data
    depends_on: [companyflags]
    restart: unless-stopped

networks:
  default:
    ipam:
      config:
        - subnet: 172.30.0.0/24

volumes:
  caddy:
```

```yaml tab="nginx"
# docker-compose.override.yml
services:
  nginx:
    image: nginx:1.27-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ./certs:/etc/nginx/certs:ro          # fullchain.pem and privkey.pem
    depends_on: [companyflags]
    restart: unless-stopped

networks:
  default:
    ipam:
      config:
        - subnet: 172.30.0.0/24
```

Then add these lines to `.env`, and run `docker compose up -d`:

```bash
BETTER_AUTH_URL=https://flags.example.com
FF_TRUSTED_PROXIES=172.30.0.0/24          # the subnet pinned in the override
```

## The console's address

`BETTER_AUTH_URL` must be the address people type, such as `https://flags.example.com`. Sign-in from any other
address is refused, and the setup link and the single sign-on addresses are built on it.

## Client addresses

Sign-in rate limits and the change-event streams count each client's address. By default that is the address of the
connection, which a client can't fake. Behind a proxy, every client would look like the proxy:

- one shared sign-in limit for everyone;
- at most `FF_EVENT_STREAMS_PER_CLIENT` (100) streams per instance in all, so only 100 devices get live updates and
  the rest poll.

Tell the server which connections are your proxies:

- **`FF_TRUSTED_PROXIES`**: their addresses or ranges, comma-separated (`10.0.0.0/8`). From those connections only,
  the server reads `X-Forwarded-For`, from the right, past the proxies.
- **`FF_CLIENT_IP_HEADER`**: a header your proxy or CDN sets itself (`cf-connecting-ip`, `x-real-ip`), read instead of
  `X-Forwarded-For`. It needs `FF_TRUSTED_PROXIES`.

A connection from any other address counts as its own address, whatever its headers say. The server refuses to start
with `FF_CLIENT_IP_HEADER` but no `FF_TRUSTED_PROXIES`, or with a proxy entry that isn't an address or a range.

| Setup | `FF_TRUSTED_PROXIES` | `FF_CLIENT_IP_HEADER` |
|---|---|---|
| Caddy or nginx in Compose (above) | The subnet pinned in the override, e.g. `172.30.0.0/24` | none |
| Cloudflare straight to the server | Cloudflare's published ranges | `cf-connecting-ip` |
| AWS Application Load Balancer | The subnets the ALB is attached to ([AWS](/self-hosting/aws#load-balancer-and-client-addresses)) | none |
| Google load balancer and Cloud Run | `169.254.0.0/16` ([Google Cloud](/self-hosting/google-cloud#load-balancer-and-client-addresses)) | `x-client-ip`, set by the load balancer |
| Azure Container Apps | The private ranges ([Azure](/self-hosting/azure#load-balancer-and-client-addresses)) | none |

With a proxy between Cloudflare and the server, add the proxy's address too, and let only Cloudflare reach the proxy.

Set them as variables, or as `auth.clientIp` in the config file: sign-in and the change-event streams read the same
setting.

## Timeouts and body sizes

- **Keep-alive.** The server keeps an idle connection open 65 seconds (`FF_KEEPALIVE_SECONDS`). That is longer than
  AWS's Application Load Balancer and Google's load balancers keep one (60 seconds), so the server never closes a
  connection the load balancer is about to use (a `502`). If you raise the load balancer's idle timeout, raise this
  above it too. A stop still closes idle connections at once.
- **Bodies.** 64 KB for OFREP, 256 KB for sign-in, 1 MB for webhooks in and the console's API, 4 MB for imports. A
  larger one gets `413`, also when it's sent in chunks ([HTTP API → Request size](/reference/http-api#request-size)).
  Let your proxy pass bodies that big.
- **Streams.** OFREP's change-event streams and the console's live updates stay open, with a heartbeat every 25
  seconds. Don't buffer them, and keep the proxy's read timeout above 120 seconds. A platform with a hard request
  limit cuts every stream at that limit, and providers reconnect.

## Keep OFREP and streams off the CDN

Only `/cdn/v1/flags/*` may be cached. Everything else, OFREP and its streams above all, goes straight to the server.
Give the CDN its own hostname, such as `cdn.flags.example.com`, that serves only those files.

- A stream held back or cached leaves providers on old values, and providers stop polling while they have a stream.
- Through a CDN, the server would have to trust every CDN range to find a device's address, and those lists change.
- CDNs cut long requests: CloudFront's origin response timeout (30 seconds) leaves 5 seconds over the heartbeat, and
  Microsoft says Front Door doesn't support server-sent events.

See [CDN → What a CDN can cache](/self-hosting/cdn#what-a-cdn-can-cache).

## What to expose

| Path | Expose it to |
|---|---|
| `/cdn/v1/flags/…` | Everyone, through the CDN when you have one |
| `/ofrep/…` | Everyone: apps read flags there |
| `/sdk/…` | Your backends. Public only if a backend outside your network reads flags |
| `/hooks/…` | The systems that post to webhooks in, only if you use them |
| `/healthz` | Your load balancer. It says only the version |
| `/readyz` | Your network only: your monitoring reads it |
| `/metrics` | Your network only, or set `FF_METRICS_TOKEN` ([Monitoring → Metrics](/self-hosting/monitoring#metrics)) |
| The console (`/`, `/assets`), `/api`, `/oauth`, `/.well-known`, `/mcp` | Your choice: everyone, or your network or VPN only. People sign in at `/api`, and AI agents use `/oauth` and `/mcp` |

The console's security headers are in [Security model → The console page](/guide/security#the-console-page).

## Next

Keep the secrets safe: [Secrets](/self-hosting/secrets).
