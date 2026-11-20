# AI resources

What an AI assistant or agent needs to work with CompanyFlags: the docs in a form it reads well, a skill with our
conventions, and a way to evaluate flags from your editor. See [Flags in the age of AI](/guide/ai) for why.

## The docs, for agents

| Address | What it is |
|---|---|
| [`/llms.txt`](/llms.txt) | An index of every page, with links to their Markdown |
| [`/llms-full.txt`](/llms-full.txt) | Every page in one file, to paste into a chat or load as context |
| Any page with `.md` | The page as Markdown: [`/guide/quickstart.md`](/guide/quickstart.md) |

## The skill

A skill teaches an agent the rules of a project: here, to put new code behind a flag, keep the code's default safe,
add the flag to `flags.json`, and never turn on a flag in production. It's one file,
[`skills/companyflags/SKILL.md`](https://github.com/dvir-daniel/companyflags/blob/main/skills/companyflags/SKILL.md).

For Claude Code, put it in your project:

```bash
mkdir -p .claude/skills/companyflags
curl -fsSL -o .claude/skills/companyflags/SKILL.md \
  https://raw.githubusercontent.com/dvir-daniel/companyflags/main/skills/companyflags/SKILL.md
```

Other agents that read skills (Cursor, Codex, …) take the same file in their own skills folder.

## A note for your AGENTS.md

If your agent reads `AGENTS.md` or `CLAUDE.md` instead, paste this into it and change the names:

```markdown
## Feature flags (CompanyFlags)

- Flags are read with OpenFeature (OFREP). Docs: https://dvir-daniel.github.io/companyflags/llms.txt
- New or AI-written code goes behind an on/off flag; the default in the code is the old behaviour.
- Add each new flag to flags.json in the same change (kind, type, removeBy for releases, services per environment),
  then run `companyflags flags plan`. Never push flags or turn a flag on in production: a person does.
- Apps use their app service's public key; backend keys stay on the server.
- Our services: web, ios, android (apps), api (backend). Our dimensions: company › brand.
```

## Connect your agent (MCP)

CompanyFlags has an MCP server at `/mcp`. An agent in Claude, Cursor, VS Code or Codex can then list and explain
flags, see what a flag gives a company, find releases to clean up, and propose changes. Each change tool first says
what it would do; with `apply: true` it does it, and where changes need approval it opens a request a person approves.

Add the server to your client with its address only. The first time, the client opens your browser: you sign in to
the console as usual, and choose what the agent may do (**Editor** or **Viewer**). The client then gets a token that
acts as you, as an agent: History shows its changes as an agent's.

```bash
# Claude Code
claude mcp add --transport http companyflags https://flags.example.com/mcp
```

```json
// Cursor (.cursor/mcp.json), VS Code and other clients that take a URL
{
  "mcpServers": {
    "companyflags": { "url": "https://flags.example.com/mcp" }
  }
}
```

The sign-in is OAuth 2.1 with PKCE. The client finds it by itself (`/.well-known/oauth-protected-resource`) and
registers itself. Its token lasts an hour, and the client renews it for as long as it's used. It shows on your
**Access tokens** page as "*client* (OAuth)": revoke it there to sign the client out.

### With an access token

For a client without OAuth sign-in, make a token yourself and send it in a header:

1. **Make a token for the agent:** in the console, your name → **Access tokens** → **+ New token**, with *For an
   agent* ticked. It is Viewer or Editor, and History shows its changes as an agent's.
2. **Add the server to your client**, with the token in a header:

```bash
# Claude Code
claude mcp add --transport http companyflags https://flags.example.com/mcp \
  --header "Authorization: Bearer cfp_…"
```

```json
// Cursor (.cursor/mcp.json) and other clients that take a URL
{
  "mcpServers": {
    "companyflags": { "url": "https://flags.example.com/mcp", "headers": { "Authorization": "Bearer cfp_…" } }
  }
}
```

For a client that only starts local servers, run the bridge from the Docker image (or `pnpm cli mcp` in a clone):

```json
{
  "mcpServers": {
    "companyflags": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "COMPANYFLAGS_URL", "-e", "COMPANYFLAGS_TOKEN", "ghcr.io/dvir-daniel/companyflags", "companyflags", "mcp"],
      "env": { "COMPANYFLAGS_URL": "https://flags.example.com", "COMPANYFLAGS_TOKEN": "cfp_…" }
    }
  }
}
```

| Tools | |
|---|---|
| Read | `list_flags`, `get_flag`, `list_services`, `list_environments`, `list_dimensions`, `history`, `stale_flags` |
| Explain | `evaluate` (what flags give a context), `explain` (why, step by step), `compare` (two entities or two environments, flag by flag) |
| Change | `create_flag`, `set_services`, `set_enabled`, `set_default`, `add_rule`, `remove_rule`, `set_entity_value` (an entity's own default, or null to remove its own settings), `rollout_step` (a release's next or last step, a %, everyone, pause), `archive_flag` |
| Requests | `list_requests`, `request_status` (its status, approvals, reviews and changes) |

Each change tool answers with a plan of what it would change. Call it again with `apply: true` to change it. Where an
environment needs approval, it answers with the number of the request a person approves.

It also has the prompts `put_behind_a_flag` and `clean_up_releases`, and each flag as a resource
(`companyflags://flags/<key>`).

### Or OpenFeature's MCP server

OpenFeature's own [`@openfeature/mcp`](https://openfeature.dev/docs/reference/other-technologies/mcp/) evaluates
flags over OFREP, and only that. Point it at your server with an app service's key in Development, in
`~/.openfeature-mcp.json`:

```json
{ "OFREP": { "baseUrl": "https://flags.example.com", "bearerToken": "ff_dev_web_…" } }
```
