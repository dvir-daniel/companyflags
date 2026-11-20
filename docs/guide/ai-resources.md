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

## Evaluate flags from your editor (MCP)

OpenFeature's own MCP server, [`@openfeature/mcp`](https://openfeature.dev/docs/reference/other-technologies/mcp/),
evaluates flags over OFREP, so it works with CompanyFlags as it is. Add it to your MCP client:

```json
{
  "mcpServers": {
    "OpenFeature": { "command": "npx", "args": ["-y", "@openfeature/mcp"] }
  }
}
```

and point it at your server with a key, in `~/.openfeature-mcp.json`:

```json
{
  "OFREP": {
    "baseUrl": "https://flags.example.com",
    "bearerToken": "ff_dev_web_…"
  }
}
```

Use an **app service's key in Development**: it reads values only, so the assistant can ask "what does `new_checkout`
give Acme?" and can't change anything. The server also gives install steps for the OpenFeature SDK of your platform.

A CompanyFlags MCP server, with tools to explain, propose and clean up flags (production changes as requests a
person approves), is planned next.
