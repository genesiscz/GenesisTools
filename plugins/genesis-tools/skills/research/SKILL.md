---
name: gt:research
description: Use when user says "research X", "look up X online", "what's the current state of X", "what are people saying about X", "find examples of X on github", "compare options for X", "is X worth using", "what do people complain about with X", or otherwise asks for information from outside the local codebase.
---

# Research

Dispatcher for internet research. Main Claude stays in charge: classifies the query, **checks which MCPs are actually available this session**, spawns narrowly-scoped subagents with explicit tool preferences and hard source minimums, then stitches their reports into a cited answer. Main Claude writes the final file; agents return raw material.

The skill is **tolerant of missing MCPs**: if a preferred MCP isn't installed, the agent uses what's available, the gap is recorded in `Confidence & Gaps`, and the user is offered a one-time install path (see "MCP availability" below).

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
2. **MCP availability check** — for each MCP listed in the category preset, check whether `mcp__<server>__<tool>` is exposed this session. Drop missing ones from the agent's allowlist; record the gap. If a more capable MCP is live that isn't in the preset, use it. **Optionally offer install** for the most-impactful missing MCP — see "MCP availability" below.
3. **Clarify if needed** — call `AskUserQuestion` once before dispatch when confidence is low (~<0.6), depth is unstated for `deep_technical`, or local-vs-online / project-vs-general is ambiguous.
4. **Dispatch** per category preset. Single agent for `factual` / `news` / `code_hunt`; parallel fan-out (2–3 agents) for `comparison` / `deep_technical` / `sentiment`. Mix Sonnet + Haiku in parallel when non-critical. Concurrency cap = 4.
5. **Stitch** — merge agent reports, dedupe sources, write file (if saving), return inline summary with citations + file pointer.

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

If a missing MCP would materially improve the run AND the user didn't say "quick"/"temporary"/"just tell me", call `AskUserQuestion` ONCE before dispatch:

- **Question:** "I'd dispatch this with `<MCP-name>` for `<one-line value-add>`, but it's not installed. Want install instructions, or proceed without?"
- **Options:** `Install now`, `Skip and proceed`, `Don't ask again this run`.

If the user picks **Install now**, read `references/mcps.md` from this skill directory and output:
1. The `bun add --global <package>` command (if local) or "no install — hosted HTTP MCP" (if remote).
2. The exact `mcpServers` JSON snippet for the user to paste into their Claude config (or the equivalent `claude mcp add` one-liner).
3. Note that the user must restart Claude Code for the new server to become callable, and the skill will proceed without it for THIS run.

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
- **Save:** if user asked or said "save to obsidian", default to `.claude/work/research/YYYY-MM-DD-HHMM-<CamelCaseTopic>.md` (time in name because news is a dated snapshot); add an Obsidian copy only if a vault resolves (see **Obsidian vault resolution**) — if none resolves, the `.claude/work/research/` file is the only output

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
- **Save:** default `.claude/work/research/YYYY-MM-DD-<CamelCaseTopic>.md` (project-scoped)
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

## Obsidian vault resolution

Runs **only when an Obsidian save is actually requested** — the user said "save to obsidian" / "braindump this", or a category preset wants an Obsidian copy *and* the user opted into saving. If no Obsidian save was asked for, skip this section entirely: never auto-detect, never prompt.

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
5. **Ask** — `AskUserQuestion`: "Where's your Obsidian vault? (absolute path)", free-text. If the user cancels or has none → fall back to `.claude/work/research/`, note it in `Confidence & Gaps`, and **do not block** the research.

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

| Trigger | Path |
|---|---|
| User says "save to Obsidian" / "braindump this" | Resolve via **Obsidian vault resolution** above → `<vault>/Braindump/YYYY-MM-DD-<CamelCaseTopic>.md` (or user-specified subfolder). If no vault resolves → `.claude/work/research/YYYY-MM-DD-<CamelCaseTopic>.md` + note in `Confidence & Gaps` |
| Category = `news` | `.claude/work/research/YYYY-MM-DD-HHMM-<CamelCaseTopic>.md` |
| Category = `code_hunt`, or query is project-scoped (mentions current repo/feature) | `.claude/work/research/YYYY-MM-DD-<CamelCaseTopic>.md` in cwd |
| Category = `comparison` / `deep_technical` and broadly useful | `.claude/work/research/YYYY-MM-DD-<CamelCaseTopic>.md`; copy to Obsidian only if a vault resolves (see **Obsidian vault resolution**), else skip the copy |
| User says "temporary" / "just tell me" / "don't save" / "quick" | inline only, no file |
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
- **`AskUserQuestion` budget.** Up to **twice** for the core run: once for the optional install offer, once for ambiguity/depth. **Plus up to two more** — *only* when an Obsidian save is requested and `$OBSIDIAN_VAULT_PATH` isn't already set: one for vault resolution (pick-from-list **or** free-text, never both) and one for the persist offer. Never prompt about the vault when no Obsidian save was asked for.
- **Tool-availability fallback.** Missing MCP → drop from allowlist, substitute per the table, note in "Confidence & Gaps".
- **Install offer is opt-in**, never automatic. Default to Skip when in doubt. Never run install commands on behalf of the user — show the command and config snippet only.
- **Vault detection is gated on an Obsidian save being requested**, and persists only with explicit consent. Never auto-edit `settings.json` or a shell rc without the user picking that option in the persist offer.
- **"Temporary" override.** Query contains "temporary", "just tell me", "don't save", "quick", "no need to save" → skip file write, skip install offer, skip the vault persist offer, inline only. Source minimums still enforced.
- **Concurrency cap = 4 parallel agents** per research run. If a preset would spawn more, drop the lowest-priority angle.
- **Honest under-count reporting** surfaces in both the inline summary and "Confidence & Gaps".
- **Mixed-model parallel** is fine when non-critical (e.g., Sonnet for docs + Haiku for Reddit in the same fan-out).

## Examples

**Example 1 — factual, all MCPs available**
User: "what's the current stable version of Bun?"
→ category=`factual`, single Haiku, jina + brave, 3 sources, inline only.

**Example 2 — comparison, reddit MCP missing, user installs**
User: "research state management options for React in 2026"
→ category=`comparison`, detect `reddit-mcp-server` missing, ask once: install / skip / don't ask. User picks Install. Skill outputs `bun add --global reddit-mcp-server` and the config snippet from `references/mcps.md`. User restarts later. Skill proceeds with Sonnet docs + Haiku GitHub (Reddit angle dropped this run, gap recorded). 8 sources combined, save to `.claude/work/research/2026-04-27-ReactStateManagement2026.md`.

**Example 3 — sentiment, user declined install**
User: "what do people complain about with tRPC, quick"
→ "quick" trigger: skip install offer. Reddit MCP missing → use `site:reddit.com` web search fallback. 6 sources, inline only. Gap noted.

**Example 4 — code_hunt, gh_grep available**
User: "find examples of how people use Effect.ts for HTTP clients on github"
→ category=`code_hunt`, single Sonnet, gh_grep + jina read, 3 cited examples, save to `.claude/work/research/2026-04-27-EffectTsHttpClient.md`.

**Example 5 — news, vault auto-detected then persisted**
User: "what happened with React Compiler recently, save to obsidian"
→ category=`news`, single Haiku on `gt:explore` (or `general-purpose` if missing), 4 sources. `OBSIDIAN_VAULT_PATH` unset → resolution runs: `obsidian-cli print-default --path-only` succeeds (or, no CLI, the `obsidian.json` registry yields one open vault). Offer once to persist it → user picks `~/.claude/settings.json`; skill merges `env.OBSIDIAN_VAULT_PATH` (takes effect next session). Save to `<vault>/Braindump/2026-04-27-1430-ReactCompilerUpdate.md` this run regardless. Had nothing resolved and the user skipped the path prompt → `.claude/work/research/2026-04-27-1430-ReactCompilerUpdate.md`, gap noted.

**Example 6 — deep_technical, depth unstated**
User: "research how Postgres MVCC works"
→ depth not stated, ask once skim/normal/deep-dive. User says deep-dive. Parallel (Sonnet docs + context7 if live + Haiku blogs), 6+ sources, save to `.claude/work/research/`.
