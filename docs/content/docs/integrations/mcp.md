---
title: "AI Agents (MCP)"
description: "An MCP server at /mcp, so AI agents read, explain and change flags with your roles and approvals. On by default."
---

**What it does.** It serves an MCP server for AI agents at `POST /mcp` (Streamable HTTP, stateless). Its tools read,
explain and compare flags, and change them through the console's API: flags, services, defaults, rules, an entity's
own default, release steps. So roles and approvals hold: where an environment needs approval, an agent's change is a
request, and `request_status` follows it.

**When you need it.** When people use agents in Claude, Cursor, VS Code or Codex to work on flags. Turn it off if
nobody does.

## Turn it on

It is on by default. To turn it off:

```bash
FF_INTEGRATIONS_OFF=mcp
```

In a config file that lists integrations, it is `mcp()`.

## How agents sign in

- **Over OAuth**, with the server's address only. The first time, the client opens the browser; the person signs in
  to the console and chooses Editor or Viewer. The client then acts as them, as an agent. Its tokens are stored as
  hashes, and **Settings → People → Remove** revokes them.
- **With an access token** (`Authorization: Bearer cfp_…`), made in the person's **Account** page, for a client
  without OAuth sign-in.
- **For clients that only start local servers:** `companyflags mcp`, which talks to the server over HTTP with
  `COMPANYFLAGS_URL` and `COMPANYFLAGS_TOKEN`.

Where admins must use two-factor sign-in, an admin who hasn't set it up can't sign in an agent until they do
([Sign-In → Two-factor sign-in](/operate/sign-in#two-factor-sign-in)).

## What it needs

- **`FF_PUBLIC_URL`**, so the sign-in addresses are right.
- **`/mcp`, `/oauth` and `/.well-known`** reachable from where agents run: everyone, or your network or VPN only
  ([Configuration → What to expose](/reference/configuration#what-to-expose)).

## More

[AI resources → Connect your agent](/guide/ai-resources#connect-your-agent-mcp): the commands for each client, the
tools, the local server, and OpenFeature's own MCP server.
