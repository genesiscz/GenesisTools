---
name: gt:research
description: Use when user says "research X", "look up X online", "what's the current state of X", "what are people saying about X", "find examples of X on github", "compare options for X", "is X worth using", "what do people complain about with X", or otherwise asks for information from outside the local codebase.
---

# Research

Dispatcher for internet research. Main Claude stays in charge: classifies the query, **checks which MCPs are actually available this session**, spawns narrowly-scoped subagents with explicit tool preferences and hard source minimums, then stitches their reports into a cited answer. Main Claude writes the final file; agents return raw material.

The skill is **tolerant of missing MCPs**: if a preferred MCP isn't installed, the agent uses what's available, the gap is recorded in `Confidence & Gaps`, and the user is offered a one-time install path (see "MCP availability" below).

⚠️ **Written with Claude Code's tool names; this plugin is installed verbatim by Codex and Grok.**
All three have subagents and a structured user question — only the names differ
(`references/harness-tools.md` in this plugin). What does NOT port is the named Claude
`subagent_type`s (`general-purpose`, `gt:explore`) and the Claude model pins: pass the agent
brief as a prompt, and read "haiku" as "a cheap model". The RESEARCH contract — source minimums,
per-category coverage, citations, `Confidence & Gaps` — holds unchanged on all three.

## When to use

- "research X", "look up X online"
- "what's the current state of X", "is X still maintained"
- "what are people saying about X", "what do people complain about with X"
- "find examples of X on github", "how do people implement Y"
- "compare options for X", "is X worth using vs Y"
- Anything needing information from outside the local codebase.

## When NOT to use

- Local codebase questions → use Grep/Glob/Read or an `Explore` agent.
- Git history / blame → use `git log` / `git blame`.
- File contents in the repo → read the file directly.
- If ambiguous (the term appears in cwd but the query sounds online-ish), call `AskUserQuestion` once before dispatching.

## Flow

1. **Classify** the query into one of six categories (see below) and produce: `{category, depth, importance, needsSave, savePath, confidence}`.
2. **Resolve the save dir** — if this run will write a file (see **Save rules**), run `scripts/resolve.ts` before dispatch (see **Where research files go**). Never read the config file yourself and never assemble the path by hand. Ask the user only when it answers `found: false`.
3. **MCP availability check** — for each MCP listed in the category preset, check whether `mcp__<server>__<tool>` is exposed this session. Drop missing ones from the agent's allowlist; record the gap. If a more capable MCP is live that isn't in the preset, use it. **Optionally offer install** for the most-impactful missing MCP — see "MCP availability" below.
4. **Clarify if needed** — call `AskUserQuestion` once before dispatch when confidence is low (~<0.6), depth is unstated for `deep_technical`, or local-vs-online / project-vs-general is ambiguous.
5. **Dispatch** per category preset. Single agent for `factual` / `news` / `code_hunt`; parallel fan-out (2–3 agents) for `comparison` / `deep_technical` / `sentiment`. Mix Sonnet + Haiku in parallel when non-critical. Concurrency cap = 4.
6. **Stitch** — merge agent reports, dedupe sources, write file (if saving), return inline summary with citations + file pointer.

## MCP availability

This skill works best with `jina`, `brave-search`, `reddit-mcp-server`, `gh_grep`, and `context7-mcp` installed. None are required.

### Detect

Before dispatch, look at the available `mcp__<server>__<tool>` tools to know which servers are live. Do NOT ask the user — verify yourself.

### Degrade

When a preferred MCP is missing, drop it from the agent's allowlist and substitute:

| Missing MCP | Fallback |
|---|---|
| `jina` (search + read) | Built-in `WebSearch` + `WebFetch` |
| `brave-search` | Whatever search MCP is live; otherwise `WebSearch` |
| `reddit-mcp-server` | Search `site:reddit.com` via `WebSearch` / `jina` (lower fidelity, no thread structure) |
| `gh_grep` | Search via `WebSearch`; or skip the github-code angle and note the gap |
| `context7-mcp` | Read official docs URLs directly via `jina` / `WebFetch` |

Always record what was missing and what substitution was used in `Confidence & Gaps`.

### Offer install (at most once per run)

If a missing MCP would materially improve the run AND the user didn't say "quick"/"temporary"/"just tell me", ask ONCE before dispatch (`AskUserQuestion`, `request_user_input_async` or `ask_user_question`, whichever your harness has):

- **Question:** "I'd dispatch this with `<MCP-name>` for `<one-line value-add>`, but it's not installed. Want install instructions, or proceed without?"
- **Options:** `Install now`, `Skip and proceed`, `Don't ask again this run`.

If the user picks **Install now**, read `references/mcps.md` from this skill directory and output:
1. The `bun add --global <package>` command (if local) or "no install — hosted HTTP MCP" (if remote).
2. The exact `mcpServers` JSON snippet for the user to paste into their Claude config (or the equivalent `claude mcp add` one-liner).
3. Note that the user must restart their agent for the new server to become callable (Claude Code and Codex reload MCP config on restart; Grok re-reads `~/.grok/config.toml` on start too), and the skill will proceed without it for THIS run.

The skill does **not** execute install commands itself. The user runs the install. The skill then proceeds with whatever is currently available.

If the user picks **Skip** or **Don't ask again**, dispatch immediately with the degraded toolset.

## Categories (6)

`factual` · `news` · `comparison` · `deep_technical` · `code_hunt` · `sentiment`

## Category presets

Tool lists are **strong nudges**, not bans: agents should prefer these; missing ones are dropped per the availability protocol; agents may use other live MCPs when clearly better.

### factual

"what version of X", "does Y support Z"

- **Agent:** single `general-purpose`, Haiku
- **Tools:** `mcp__jina__search_web`, `mcp__jina__read_url`, `mcp__brave-search__brave_web_search` — fall back to `WebSearch` + `WebFetch` if all missing
- **Min sources:** 3
- **Save:** inline only unless user asks

### news

"what happened with X recently", time-sensitive

- **Agent:** single `gt:explore` (or `general-purpose` if `gt:explore` not installed), Haiku
- **Tools:** `mcp__brave-search__brave_web_search`, `mcp__jina__parallel_read_url`; if `obsidian:defuddle` skill is available use it for clean article capture
- **Min sources:** 4
- **Save:** if user asked or said "save to obsidian", write `<defaultDir>/YYYY-MM-DD-HHMM-<CamelCaseTopic>.md` (time in name because news is a dated snapshot); prefer the vault Braindump path when the user asked for Obsidian and a vault resolves (see **Obsidian vault resolution**) — otherwise `<defaultDir>` is the only output

### comparison

"compare X vs Y vs Z", "what's the best library for"

- **Agents (parallel, 2–3):**
  - A — Sonnet, `general-purpose`, docs + official sources (`mcp__jina__search_web`, `mcp__jina__parallel_read_url`, `mcp__brave-search__brave_web_search`)
  - B — Haiku, `general-purpose`, Reddit (`mcp__reddit-mcp-server__search_reddit`, `mcp__reddit-mcp-server__get_post_comments`, `mcp__reddit-mcp-server__get_top_posts`) — drop entire angle if `reddit-mcp-server` missing AND user declined install; substitute `site:reddit.com` web search if proceeding degraded
  - C — Haiku, `general-purpose`, GitHub issues/discussions via `gt:github` skill if available, sorted by reactions/comments count
- **Min sources:** 8 combined
- **Save:** always

### deep_technical

"how does X work under the hood"

- **Depth gate:** if user didn't indicate depth, call `AskUserQuestion` once: "skim / normal / deep-dive".
- **Agents (parallel, 2):**
  - A — Sonnet, `gt:explore` if available else `general-purpose`, official docs + deep-reads (`mcp__jina__parallel_read_url`; if a library is named AND `context7-mcp` is live, `mcp__context7-mcp__resolve-library-id` then `mcp__context7-mcp__get-library-docs`)
  - B — Haiku, `general-purpose`, blog posts / writeups (`mcp__brave-search__brave_web_search`, `mcp__jina__search_web`, `mcp__jina__read_url`)
- **Min sources:** 6 (more for deep-dive)
- **Save:** always

### code_hunt

"find examples of X on github", "how do people implement Y"

- **Agent:** single `general-purpose`, Sonnet (precision matters for code)
- **Tools:** `mcp__gh_grep__searchGitHub` (primary), `gt:github` skill for issues/PRs if available, `mcp__jina__read_url` for specific files
- **Min sources:** 3 real code examples, each cited with repo + path
- **Save:** `<defaultDir>/YYYY-MM-DD-<CamelCaseTopic>.md` (from **Where research files go**)
- **Nudge the user** if the query is vague — "find auth examples" is too broad; ask what language/framework/approach before dispatching.

### sentiment

"what do people complain about with X", "is X worth using"

- **Agents (parallel, 2, both Haiku):**
  - A — Reddit angle (`mcp__reddit-mcp-server__search_reddit` + `mcp__reddit-mcp-server__get_post_comments` + `mcp__reddit-mcp-server__get_top_posts`); fall back to `site:reddit.com` web search if missing
  - B — GitHub issue threads via `gt:github` skill (sorted by reactions); fall back to `WebSearch` for `site:github.com` issues if missing
- **Min sources:** 6 distinct posts/threads
- **Save:** optional; inline unless asked

## Source minimums (hard)

| Category | Min |
|---|---|
| factual | 3 |
| news | 4 |
| comparison | 8 combined |
| deep_technical | 6 |
| code_hunt | 3 (with repo + path) |
| sentiment | 6 |

Agents must either meet the count or return **"Under-count: found X of N required"**. No invention. No padding with low-quality links. Main Claude surfaces under-counts in the inline summary and the "Confidence & Gaps" section of the file.

## Where research files go

**One command answers it. Never reconstruct the path by hand, and never read the config file yourself.**

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/research/scripts/resolve.ts"                       # from the repo you worked in
bun "…/resolve.ts" --project /path/to/repo --branch feat/x                           # pin it when the shell cwd is stale
bun "…/resolve.ts" --path ~/Notes/scratch                                            # this run only
bun "…/resolve.ts" config                                                            # what is configured, and where
```

It prints JSON: `dir`, `source`, `found`, the resolved `project` / `branch` / `cwd`, and
`warnings`. **Read `warnings` out loud to the user before writing.** They are the reasons the
directory may be the wrong one, and they exist because the usual failure here is a confident
wrong answer, not a missing one.

`source` says which tier answered:

| `source` | Meaning |
|---|---|
| `request` | you passed `--path`; this run only |
| `resolver` | the project declares a `resolverCommand` that DERIVES the directory |
| `registry` | a project-to-folder mapping shared with the wrap-up skill |
| `config` | the global `defaultPath`, shared with every other project |
| `none` | nothing matched — ask the user, then offer to register a folder |

🛑 When a project declares a `resolverCommand` and the resolver fails, the tool exits 1 and
does **not** fall back to `defaultPath`. Falling back is how one project's research lands in
another project's folder. Fix the resolver or pass `--path`.

### The config

`~/.genesis-tools/plugins/config.json`, shared by every genesis-tools plugin, one key each:

```json
{
  "research": {
    "defaultPath": "/abs/path/or/relative",
    "pathKind": "absolute",
    "projectOverrides": {
      "/Users/me/Projects/acme": {
        "resolverCommand": "bun ~/.genesis-tools/plugins/resolvers/acme.ts --cwd <cwd>",
        "appliesToWorktrees": true,
        "rule": "one sentence the agent shows the user"
      }
    }
  },
  "wrap-up": { "vaultDir": "…" },
  "obsidian": { "vaultRoot": "…" }
}
```

`defaultPath` is a directory, never a filename; the Save rules below add the filename.
`pathKind` is `absolute` or `project-relative`. A missing `pathKind` is read as
`project-relative` unless the path is already absolute.

⚠️ `defaultPath` is **global**. Whichever project sets it, sets it for all of them. If research
for this project belongs somewhere of its own, that is a `projectOverrides` entry or a registry
entry, not a new `defaultPath`.

Migrated automatically, once, on first use: `~/.genesis-tools/skills/research/config.json`
moves into the `research` key and the old file is renamed to `*.migrated-<date>`.

### Writing a resolver

A `resolverCommand` is for a directory that **cannot be written down**, because it depends on
something that changes per branch or per ticket: an issue id, an MR number, a sprint. If a
static path works, use the registry instead and write no code.

**Where it goes.** Anywhere executable; `~/.genesis-tools/plugins/resolvers/<project>.ts` is the
conventional home. It is the user's file, not part of this plugin, and it is never installed or
updated by GenesisTools. You write it for them when they ask, then add the `projectOverrides`
entry that points at it.

**What it receives.** The command string is a shell command with placeholders substituted
before it runs:

| Placeholder | Value |
|---|---|
| `<cwd>` | the directory the resolve was made from |
| `<project>` | the MAIN checkout of the repo, so worktrees of one project agree |
| `<worktree>` | the checkout actually in use, which differs from `<project>` inside a linked worktree |
| `<branch>` | the resolved branch |

Pass only what the resolver needs. Anything else it wants (a remote, an API, a directory
listing) it fetches itself.

**What it must print.** One JSON object on stdout:

```json
{ "dir": "/absolute/path/to/folder", "warnings": ["…"], "from": ["how it decided"] }
```

- `dir` is required, absolute, and a directory. Missing or empty `dir` is treated as failure.
- `warnings` is optional and is **merged into the tool's own warnings**, so a resolver can tell
  the user "I reused an existing folder" or "this name predates the current convention".
- Anything else is echoed back under `resolver.output` for the agent to read.

**Rules it must follow.** Exit 0 when it resolved. Print nothing but JSON on stdout, since
stdout is parsed. Prefer reusing a folder that already exists for the same key over creating a
second one. Never create the directory itself: the caller does that when it writes the file.


## Obsidian vault resolution

Runs when an Obsidian path is needed: the user said "save to obsidian" / "braindump this", they picked **Obsidian Braindump** in the default-path ask, or a category preset wants an Obsidian copy *and* a vault is required to finish path resolution. If none of those apply, skip this section: never auto-detect, never prompt about the vault.

Resolve the vault path in this order; **stop at the first hit:**

1. **`$OBSIDIAN_VAULT_PATH` set and non-empty** → use it. No detection, no prompt, no persist offer.
2. **User named a path in the request** ("save to ~/Notes/…") → expand `~`, use it.
3. **`obsidian-cli`** — only if `command -v obsidian-cli` succeeds. Run `obsidian-cli print-default --path-only`. Accept the result only if exit code is `0` **and** stdout is non-empty **and** the trimmed path is an existing directory (`[ -d "$path" ]`). `obsidian-cli` being on PATH does NOT imply a default vault is configured (`set-default` may never have run).
4. **Obsidian desktop registry** (no CLI needed) — read the `vaults` map from the platform config file:
   - macOS: `~/Library/Application Support/obsidian/obsidian.json`
   - Linux: `${XDG_CONFIG_HOME:-~/.config}/obsidian/obsidian.json`
   - Windows: `%APPDATA%\obsidian\obsidian.json`

   Expand `~`. If the file is missing, unreadable, or not valid JSON → silently advance to step 5 (never surface an error). Each entry looks like `{ "path": "...", "ts": <last-opened-ms>, "open": true }`. Selection:
   - drop any entry whose `path` no longer exists on disk;
   - exactly one remaining → use its `path`;
   - multiple → auto-pick the one with `"open": true`, else the highest `ts`. Only if still ambiguous (no `open`, missing/tied `ts`) → `AskUserQuestion` listing vault basenames.
5. **Ask** — `AskUserQuestion`: "Where's your Obsidian vault? (absolute path)", free-text. If the user cancels or has none → **do not block** the research; note it in `Confidence & Gaps` and write to the first of these that is defined:
   - `<defaultDir>` from **Where research files go**, when `resolve.ts` has already produced one;
   - otherwise the repo's `.claude/research/` if you are in a repo, else `~/research/`. Create the directory if it does not exist.

### Persist the resolved path (offer once)

If the path came from steps 2–5 (i.e. it was **not** already in `$OBSIDIAN_VAULT_PATH`) — and this isn't a "temporary"/"quick" run — offer once to persist it so future runs skip detection. **Exception:** if the path came from step 2 (a user-named path), only offer to persist it when it's actually a vault root (contains a `.obsidian/` subdir); a one-off subfolder like `~/Notes/scratch` should be used for this run but never saved as the global `OBSIDIAN_VAULT_PATH`. `AskUserQuestion`:

- **Question:** "Save `OBSIDIAN_VAULT_PATH=<path>` so I can skip detection next time?"
- **Options:**
  - **`~/.claude/settings.json`** — Claude-only; the harness injects the `env` block into Claude Code's environment at session start. Add/replace `OBSIDIAN_VAULT_PATH` inside the top-level `env` object (create `env` if absent). **Use the Read + Edit tools to splice the one key in place** — do NOT parse-and-rewrite the whole file (settings.json is JSONC; a strict `JSON.parse`/stringify round-trip would strip comments and reformat unrelated keys).
  - **Shell rc** — all tools, all shells. Detect from `$SHELL`: zsh → `~/.zshrc`, bash → `~/.bashrc`, fish → `~/.config/fish/config.fish`. Append `export OBSIDIAN_VAULT_PATH="<path>"` (fish: `set -Ux OBSIDIAN_VAULT_PATH "<path>"`). If a line already sets it, replace that line instead of duplicating.
  - **`Just this run`** — don't persist.

A persisted value only takes effect in **new** sessions/shells; use the resolved path for THIS run regardless, and say so. The skill writes only the one chosen file — never both.

## Save rules

Main Claude decides the path **before** dispatching and passes the explicit absolute path to any agent that saves raw material. Agents never guess paths.

**`<defaultDir>`** = the `dir` that `scripts/resolve.ts` printed. It is already absolute.

| Trigger | Path |
|---|---|
| User says "save to Obsidian" / "braindump this" | Resolve via **Obsidian vault resolution** above → `<vault>/Braindump/YYYY-MM-DD-<CamelCaseTopic>.md` (or user-specified subfolder). If no vault resolves → `<defaultDir>/YYYY-MM-DD-<CamelCaseTopic>.md` + note in `Confidence & Gaps` |
| Category = `news` | `<defaultDir>/YYYY-MM-DD-HHMM-<CamelCaseTopic>.md` |
| Category = `code_hunt`, or query is project-scoped (mentions current repo/feature) | `<defaultDir>/YYYY-MM-DD-<CamelCaseTopic>.md` |
| Category = `comparison` / `deep_technical` and broadly useful | `<defaultDir>/YYYY-MM-DD-<CamelCaseTopic>.md`. Extra Obsidian copy only when the user asked for one, or when `defaultPath` already points into a vault (do not silently invent a second copy). |
| User says "temporary" / "just tell me" / "don't save" / "quick" | inline only, no file (skip config read and the default-path ask) |
| `factual` / small `sentiment` | inline only unless user asked |

**CamelCase topic slug:** generate from the query, max 6 words, strip stopwords. "what's the current state of server components in react?" → `ReactServerComponentsState`. Never kebab-case.

## Output file template

Main Claude writes this. Every Findings sub-section cites its sources inline; the final `## Sources` section is the deduped master list with retrieval dates.

```markdown
# <Topic>

**Date:** YYYY-MM-DD HH:MM
**Category:** <factual|comparison|deep_technical|code_hunt|sentiment|news>
**Query:** <user's original ask, verbatim>
**Agents:** <e.g., "Sonnet x1 + Haiku x2 (parallel)">
**MCPs used:** <comma-list of mcp__server names actually called>
**MCPs unavailable:** <comma-list of preset MCPs that were missing this run, or "none">

## TL;DR
<2–4 sentences>

## Findings

### <sub-topic A>
<content>

_Sources: [title](url), [title](url)_

### <sub-topic B>
<content>

_Sources: [title](url)_

## Sources
- [Title](url) — one-line takeaway — _retrieved YYYY-MM-DD_
- ...

## Confidence & Gaps
<under-count note if sources below minimum; conflicting info; MCPs unavailable and substitutions used; whether the user declined an install offer this run>
```

**Inline summary (always returned to user):** 2–4 sentence TL;DR + top 3 sources with links + file pointer (if saved) + one-line note if any MCPs were missing.

## Agent prompt template

Main Claude fills in per agent. Keep each agent narrow to one angle.

```text
ROLE: <one-line: "Reddit sentiment angle", "official docs deep-read", etc.>

QUERY: <user's original ask, verbatim>

ANGLE: <what this specific agent should cover>

PREFERRED TOOLS (prefer these; avoid other MCPs unless you hit a dead end and another is clearly better):
- <tool1>
- <tool2>
- ...

FALLBACKS IF PREFERRED TOOLS UNAVAILABLE:
- <preferred> → <fallback>
- ...

MINIMUM SOURCES: <N distinct sources>
If you cannot reach N, return what you have and state exactly:
"Under-count: found X of N required"
Do not invent sources. Do not pad with low-quality links.

RETURN FORMAT:
- Summary (2–4 sentences)
- Findings, grouped by sub-topic, each followed by inline source citations
- Source list: URL + one-line takeaway + retrieval date
- Confidence note (conflicting info, dead ends, MCPs that didn't respond)

<include only if this agent is saving raw material:>
SAVE RAW REPORT TO: <exact absolute path, provided by main Claude>
```

## Guardrails

- **Source minimums are hard** (see table above). No invention, no padding.
- **Always run `scripts/resolve.ts` when saving, and surface its `warnings`.** Never hardcode `.claude/work/research/`, never read the config file yourself, and never fall back to `defaultPath` when a project declares a resolver that failed.
- **Ask the default path at most once until remembered.** If `config.json` is missing or unusable and this run will save, ask then write the file. Do not re-ask on later runs while the config is valid. "Change research path" is the explicit re-ask trigger.
- **`AskUserQuestion` budget.** Up to **three** for the core run: once for the optional install offer, once for ambiguity/depth, once for the default research path when config is unset. **Plus up to two more** — *only* when an Obsidian path is required and `$OBSIDIAN_VAULT_PATH` isn't already set: one for vault resolution (pick-from-list **or** free-text, never both) and one for the vault persist offer. Never prompt about the vault when no Obsidian path is needed.
- **Tool-availability fallback.** Missing MCP → drop from allowlist, substitute per the table, note in "Confidence & Gaps".
- **Install offer is opt-in**, never automatic. Default to Skip when in doubt. Never run install commands on behalf of the user — show the command and config snippet only.
- **Vault detection is gated on an Obsidian path being needed**, and persists only with explicit consent. Never auto-edit `settings.json` or a shell rc without the user picking that option in the persist offer.
- **"Temporary" override.** Query contains "temporary", "just tell me", "don't save", "quick", "no need to save" → skip file write, skip install offer, skip default-path ask, skip the vault persist offer, inline only. Source minimums still enforced.
- **Concurrency cap = 4 parallel agents** per research run. If a preset would spawn more, drop the lowest-priority angle.
- **Honest under-count reporting** surfaces in both the inline summary and "Confidence & Gaps".
- **Mixed-model parallel** is fine when non-critical (e.g., Sonnet for docs + Haiku for Reddit in the same fan-out).

## Examples

**Example 1 — factual, all MCPs available**
User: "what's the current stable version of Bun?"
→ category=`factual`, single Haiku, jina + brave, 3 sources, inline only.

**Example 2 — comparison, first save (no research config yet), reddit MCP missing**
User: "research state management options for React in 2026"
→ category=`comparison`, `needsSave=true`, `scripts/resolve.ts` answers `found: false` → ask once where research for this project belongs. User picks Project `.claude/work/research/`. Write the `research` key of the shared config (`pathKind: project-relative`, `defaultPath: .claude/work/research`). Detect `reddit-mcp-server` missing, ask once: install / skip / don't ask. User picks Install. Skill outputs `bun add --global reddit-mcp-server` and the config snippet from `references/mcps.md`. User restarts later. Skill proceeds with Sonnet docs + Haiku GitHub (Reddit angle dropped this run, gap recorded). 8 sources combined, save to `<repo>/.claude/work/research/2026-04-27-ReactStateManagement2026.md`.

**Example 3 — sentiment, user declined install**
User: "what do people complain about with tRPC, quick"
→ "quick" trigger: skip install offer, skip default-path ask, skip file write. Reddit MCP missing → use `site:reddit.com` web search fallback. 6 sources, inline only. Gap noted.

**Example 4 — code_hunt, config already set**
User: "find examples of how people use Effect.ts for HTTP clients on github"
→ category=`code_hunt`, config already has project-relative `.claude/work/research` → no path ask. Single Sonnet, gh_grep + jina read, 3 cited examples, save to `<defaultDir>/2026-04-27-EffectTsHttpClient.md`.

**Example 5 — news, vault auto-detected then persisted**
User: "what happened with React Compiler recently, save to obsidian"
→ category=`news`, single Haiku on `gt:explore` (or `general-purpose` if missing), 4 sources. Per-request Obsidian override wins for THIS run (does not rewrite research `config.json` unless the user also asked to make Braindump the default). `OBSIDIAN_VAULT_PATH` unset → vault resolution runs: `obsidian-cli print-default --path-only` succeeds (or, no CLI, the `obsidian.json` registry yields one open vault). Offer once to persist the vault env → user picks `~/.claude/settings.json`; skill merges `env.OBSIDIAN_VAULT_PATH` (takes effect next session). Save to `<vault>/Braindump/2026-04-27-1430-ReactCompilerUpdate.md` this run regardless. Had nothing resolved and the user skipped the vault prompt → `<defaultDir>/2026-04-27-1430-ReactCompilerUpdate.md`, gap noted.

**Example 6 — deep_technical, depth unstated, change default later**
User: "research how Postgres MVCC works"
→ depth not stated, ask once skim/normal/deep-dive. User says deep-dive. Config already set → no path ask. Parallel (Sonnet docs + context7 if live + Haiku blogs), 6+ sources, save under `<defaultDir>/`.
Later: "change research path" → run `scripts/resolve.ts config`, show it, re-ask, rewrite the `research` key of `~/.genesis-tools/plugins/config.json`.
