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
5. **Dispatch** per category preset. Single agent for `factual` / `news` / `code_hunt`; parallel fan-out (2–3 agents) for `comparison` / `deep_technical` / `sentiment`. Mix Sonnet + Haiku in parallel when non-critical. Concurrency cap = 4. When the query names observed symptoms (measured numbers, an error, "X differs from Y"), put them in a `CONTEXT:` line and add the **METHOD block** (see **Agent prompt template**) to every brief, whatever the model.
6. **Stitch** — every agent report ends with a Claims ledger (the CLAIMS block goes into every brief). Run `bun <this skill directory>/scripts/check-ledger.ts <report>` on each: it fetches each proof and confirms its quoted passage is there. Then look at every ledger line the answer rests on that it marks `missing`, `no-proof`, `unloaded`, `mostly` or `by-hand`: run its `verify`, and lower or drop a claim whose proof fails or stays unconfirmed. The script exits 1 while a claim at 80% or more is `missing`, `no-proof` or `unloaded`, and lists those claims. Merge agent reports, dedupe sources, write file (if saving), return inline summary with citations + file pointer.

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

- **Agent:** single `general-purpose`, Haiku at effort `xhigh`
- **Tools:** `mcp__jina__search_web`, `mcp__jina__read_url`, `mcp__brave-search__brave_web_search` — fall back to `WebSearch` + `WebFetch` if all missing
- **Min sources:** 3
- **Save:** inline only unless user asks

### news

"what happened with X recently", time-sensitive

- **Agent:** single `gt:explore` (or `general-purpose` if `gt:explore` not installed), Haiku at effort `xhigh`
- **Tools:** `mcp__brave-search__brave_web_search`, `mcp__jina__parallel_read_url`; if `obsidian:defuddle` skill is available use it for clean article capture
- **Min sources:** 4
- **Save:** if user asked or said "save to obsidian", write `<defaultDir>/YYYY-MM-DD-HHMM-<CamelCaseTopic>.md` (time in name because news is a dated snapshot); prefer the vault Braindump path when the user asked for Obsidian and a vault resolves (see **Obsidian vault resolution**) — otherwise `<defaultDir>` is the only output

### comparison

"compare X vs Y vs Z", "what's the best library for"

- **Agents (parallel, 2–3):**
  - A — Haiku at effort `xhigh`, `general-purpose`, docs + official sources (`mcp__jina__search_web`, `mcp__jina__parallel_read_url`, `mcp__brave-search__brave_web_search`)
  - B — Haiku at effort `xhigh`, `general-purpose`, Reddit (`mcp__reddit-mcp-server__search_reddit`, `mcp__reddit-mcp-server__get_post_comments`, `mcp__reddit-mcp-server__get_top_posts`) — drop entire angle if `reddit-mcp-server` missing AND user declined install; substitute `site:reddit.com` web search if proceeding degraded
  - C — Haiku at effort `xhigh`, `general-purpose`, GitHub issues/discussions via `gt:github` skill if available, sorted by reactions/comments count
- **Min sources:** 8 combined
- **Save:** always

### deep_technical

"how does X work under the hood"

- **Depth gate:** if user didn't indicate depth, call `AskUserQuestion` once: "skim / normal / deep-dive".
- **Agents (parallel, 2):**
  - A — Sonnet, `gt:explore` if available else `general-purpose`, official docs + deep-reads (`mcp__jina__parallel_read_url`; if a library is named AND `context7-mcp` is live, `mcp__context7-mcp__resolve-library-id` then `mcp__context7-mcp__get-library-docs`)
  - B — Haiku at effort `xhigh` (Sonnet when the query names observed symptoms, see **Model routing**), `general-purpose`, blog posts / writeups (`mcp__brave-search__brave_web_search`, `mcp__jina__search_web`, `mcp__jina__read_url`)
- **Min sources:** 6 (more for deep-dive)
- **Save:** always

### code_hunt

"find examples of X on github", "how do people implement Y"

- **Agent:** single `general-purpose`, Sonnet (precision matters for code)
- **Tools:** `mcp__gh_grep__searchGitHub` (primary), `gt:github` skill for issues/PRs if available, `mcp__jina__read_url` for specific files
- **Reading code:** put the code-reading ladder (METHOD rule 11) in the brief: pin one commit, then raw files or `gh api` when a reader fails, then `gh search code` when a path moved.
- **Min sources:** 3 real code examples, each cited with repo + path
- **Save:** `<defaultDir>/YYYY-MM-DD-<CamelCaseTopic>.md` (from **Where research files go**)
- **Nudge the user** if the query is vague — "find auth examples" is too broad; ask what language/framework/approach before dispatching.

### sentiment

"what do people complain about with X", "is X worth using"

- **Agents (parallel, 2, both Haiku at effort `xhigh`):**
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
| `override` | the project pins a static `dir` for research in `projectOverrides` |
| `resolver` | the project declares a `resolverCommand` that DERIVES the directory |
| `registry` | a project-to-folder mapping shared with the wrap-up skill |
| `config` | the global `defaultPath`, shared with every other project |
| `none` | nothing matched — ask the user, then offer to register a folder |

🛑 When a project declares a `resolverCommand` and the resolver fails, the tool exits 1 and
does **not** fall back to `defaultPath`. Falling back is how one project's research lands in
another project's folder. Fix the resolver or pass `--path`.

### The config

`~/.genesis-tools/plugins/config.json`, shared by every genesis-tools plugin, one key each.
`projectOverrides` is its own TOP-LEVEL key, shared by research and wrap-up, and each project
names its folder per plugin under `consumers`:

```json
{
  "research": {
    "defaultPath": "/abs/path/or/relative",
    "pathKind": "absolute"
  },
  "projectOverrides": {
    "/Users/me/Projects/acme": {
      "appliesToWorktrees": true,
      "rule": "one sentence the agent shows the user",
      "consumers": {
        "research": { "resolverCommand": "bun ~/.genesis-tools/plugins/resolvers/acme.ts --cwd <cwd>" }
      }
    }
  },
  "wrap-up": { "vaultDir": "…" },
  "obsidian": { "vaultRoot": "…" }
}
```

🛑 A `projectOverrides` block nested inside `"research"`, or a `resolverCommand` placed directly
on the project block, is never read: research then resolves from the registry or `defaultPath`
without a warning. `consumers.research` takes either `resolverCommand` or a static `dir`.

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

🛑 **No value is ever pasted into the command.** Each placeholder becomes a quoted reference to an
environment variable (`"${GT_RESOLVER_BRANCH}"`), and the values reach `sh -c` in its environment.
A branch name is not a safe token (git permits `;`, `$`, backticks and quotes), and this is what
keeps a checkout name from running commands. A resolver that has not answered after 30 s is
stopped. So write the placeholder bare:

```bash
# right — the quoting is already there
bun ~/.genesis-tools/plugins/resolvers/acme.ts --cwd <cwd> --branch <branch>

# also handled, but not needed — the reference adapts to the quotes around it
bun ~/.genesis-tools/plugins/resolvers/acme.ts --cwd '<cwd>'
```

A placeholder after a heredoc (`<<`) or inside a `$(…)`, `${…}` or backticks within double quotes
is refused with an error, because the reference form there cannot be chosen reliably.

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

## Claims ledger
<the 10–15 claims the answer rests on, merged from the agents' ledgers, highest stakes first:>
- [NN%] <claim> (proof: <url + quoted passage | file at commit + quoted line | command + output>) — check: <found | mostly | checked by hand | missing → lowered>
- ...

## Sources
- [Title](url) — one-line takeaway — _retrieved YYYY-MM-DD_
- ...

## Confidence & Gaps
<under-count note if sources below minimum; conflicting info; MCPs unavailable and substitutions used; whether the user declined an install offer this run>
```

**Inline summary (always returned to user):** 2–4 sentence TL;DR + top 3 sources with links + file pointer (if saved) + one-line note if any MCPs were missing. Every load-bearing claim in the summary carries its `[NN%]` and the proof it rests on, as in the ledger.

## Model routing

Measured 2026-10-12 on four questions, each report graded blind by an opus grader against an answer key it built from primary sources. Prices are list prices computed from each run's per-call usage (Haiku 5.5 costs a twentieth of Sonnet 5.5 per token, but research prompts pass 100k tokens, where Haiku's price rises 5x). One run per setup and angle, so treat the numbers as observations.

**Web research (no source code):** Temporal API support across browsers and runtimes, and a self-hosted S3 storage comparison.

| Setup | Scores | Price per run | Minutes |
|---|---|---|---|
| Haiku, effort `xhigh` | 7/8 and 9.5/10 | $0.26 and $0.33 | 5.8 and 7.2 |
| Sonnet, effort `xhigh` | 8/8 and 9.5/10 | $1.23 and $1.84 | 8.2 and 10.4 |

**Explaining an observed symptom from source code:** IndexedDB disk size in Chromium (two angles), and SQLite file size.

| Setup | Scores | Price per run | Minutes |
|---|---|---|---|
| Sonnet + METHOD | 7/7 in all 3 runs | $3.24 to $5.56 | 16 to 44 |
| Haiku `xhigh` + METHOD | 6.5, 6 and 6/7, 2-3 wrong claims each | $0.96 to $1.86 | 14 to 23 |
| Haiku `xhigh` + METHOD, then a Sonnet verify pass | 7/7 | $3.21 in total | 29 |
| Haiku `xhigh` + an older METHOD (IndexedDB only) | 6 and 4.5/7 | $1.33 and $0.96 | 17 and 15 |
| Haiku at default effort + the older METHOD (IndexedDB only) | 3.5 and 3.5/7 | $0.27 and $0.62 | |

- **Haiku at `effort: "xhigh"` for web research:** factual, news, sentiment, comparison, blog and writeup angles. It reached 88% and 100% of Sonnet's score for about a fifth of the price, and finished sooner. Pass `effort` on the Agent call; this skill asks for it. At default effort Haiku stops early: on the IndexedDB question it made 20 and 49 model calls, against 42 to 107 at `xhigh`. Effort explained most of its old 50% score: with the same older METHOD at `xhigh` it scored 10.5 of 14 instead of 7, and the newer METHOD rules added about 2 more points.
- **Sonnet with the METHOD block when an angle digs into source code to explain a symptom**, and for `code_hunt`. Haiku at `xhigh` reaches 86 to 89% there, but its misses are confident claims about specific builds and defaults, the kind a reader acts on (one called a writing diagnostic read-only).
- **Haiku first, then a Sonnet verify pass** to rescue a Haiku report that a decision will rest on. Brief the verifier to: list the report's 10 to 15 load-bearing claims; check each against a primary source or a script of about 10 lines; fix wrong claims in place, marked `[corrected]`; fill at most three gaps, marked `[added]`; end with a Verification section (claim, verdict, proof). It lifted a 6/7 report to 7/7 and fixed every wrong build claim, at the same total price as Sonnet alone.
- **The CLAIMS block stops Haiku's confident wrong claims.** Without it, a Haiku report on the SQLite question stated 3 wrong facts about a specific build as plain fact. With it, two Haiku runs on the same question had 0 wrong claims at 80% or more (30 rated claims, every 80-99% claim right or partly right) at the same 6/7 score, and on the Temporal question 0 wrong among 24 rated claims, with the score up from 7 to 7.5 of 8. It cost $0.66 and $1.30 on SQLite (was $0.96) and $0.53 on Temporal (was $0.26). The errors left were in untagged prose and in claims wider than their proof, which rules 4 and 5 now cover. `scripts/check-ledger.ts` then checks the proofs in seconds.
- **Without the CLAIMS block, Haiku also under-states settled facts:** on the Temporal question it lost a point by marking two facts [unconfirmed] that a primary source settles. Rule 7 of CLAIMS covers that, and with it one of the two was stated plainly. Stitching should check those items before the final answer.

## Agent prompt template

Main Claude fills in per agent. Keep each agent narrow to one angle.

```text
ROLE: <one-line: "Reddit sentiment angle", "official docs deep-read", etc.>

QUERY: <user's original ask, verbatim>

<include when the user observed or measured something:>
CONTEXT: <the symptoms, with their numbers; what we already do; what we lack; local resources the agent may use (installed apps, packages, a scratch dir)>

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

<include when CONTEXT lists symptoms; for every model:>
METHOD (follow it in this order; a list of related links is not enough, the goal is findings that change what we do):
1. Explain each symptom from source code. For each symptom in CONTEXT, find the code that causes it in the component that produces it (its source on GitHub or an official mirror, or an installed copy named in CONTEXT). A README, a blog post or a docs page is not enough. Cite repo or package + file + line. Then write the mechanism in one sentence, and its consequence for our data in one sentence. A symptom you cannot trace goes into the confidence note as "unexplained".
2. List what the artifact already carries. For each component that writes the artifact named in CONTEXT, read what it writes INTO it (records, metadata, side files). For each item, say what it tells us and how we could read it.
3. Look for a system that already holds what we lack. Check whether a component already computes or stores it, and how to get it (API, command, internal page). When that component is open source, search its own code for the entry point, not only its docs; docs often omit what the system itself uses.
4. Test a cheap claim yourself. When a claim can be checked with a script of about 10 lines, write it and run it. Work only in <SCRATCH_DIR>. Report the script and its output. Do not install packages. Do not run code you downloaded.
5. Label every load-bearing claim: [source] you read it in code or official docs, [test] your own script checked it, [snippet] you saw it only in a search result, [inference] your own reasoning. Never present a [snippet] or an [inference] as a fact.
6. Check every absence claim. Before you write "X does not do Y", "Y is not stored" or "there is no API for Z", follow every function in the code path and search the code for the thing you claim is absent. If you cannot check it, label it [unchecked absence], not a finding.
7. Make a test match the symptom. A test must reproduce the two conditions the symptom compares. End each test with one sentence: it confirms, contradicts, or does not decide the symptom.
8. Read every layer. Read at least one source file (or primary doc page) in every directory, component or layer the ANGLE names, and list them in the confidence note. A symptom explained by one layer only is not done.
9. Numbers are leads. When your own measurement or a source gives a number your mechanism does not explain (a 2x, a threshold, a size), trace it in code or primary docs before you write "unexplained".
10. Find the trigger for anything time-dependent. When a symptom depends on WHEN something runs (cleanup, compaction, flush, rotation), find the code or doc that schedules it: timers, size thresholds, open and close hooks.
11. Code-reading ladder. Pin one commit SHA (or one dated doc version) at the start and cite permalinks. If a reader tool fails on a code file, fetch https://raw.githubusercontent.com/<owner>/<repo>/<sha>/<path> or run `gh api repos/<owner>/<repo>/contents/<path>?ref=<sha> --jq .content | base64 -d`. If a path returns 404, find where it moved with `gh search code '<symbol> repo:<owner>/<repo>'` or mcp__gh_grep__searchGitHub before you mark it unread.
12. Never copy data out of a real user profile, browser or account. Create your own test data in a scratch location.
RETURN FORMAT ADDITION: right after the Summary, add a section "Mechanisms" with one entry per symptom from step 1, then the results of steps 2 and 3, then any tests from step 4.

<include for every agent, whatever the model: Haiku, Sonnet, Opus, or another runtime's worker:>
CLAIMS (for every load-bearing claim: a version, a default, a date, a limit, a behavior, a cause, "safe" or "read-only"):
1. Write it as one line: `[NN%] <claim> (proof: <proof>)`. A proof is one of: a URL plus a quoted passage of at most 25 words; a permalink to a file at a pinned commit plus the quoted line; a command you ran plus the output line that shows the claim (save the output to a log file in your scratch folder and link it). With no proof, write `(proof: none)` and keep NN at 50 or below.
2. Set NN from the proof, not from how sure you feel. 90-99: you read the primary source (official docs, source code, release notes, standards text) or ran the test yourself, and the quote or output states exactly the claim. 70-89: a primary source supports it but does not state it exactly, or your test checked a close variant. 50-69: only a secondary source (blog, forum, search snippet), or your own inference from a primary source. Below 50: unverified.
3. A claim about how a specific build, vendor package, version or installed tool behaves (its defaults, flags, bundled libraries, whether a command writes) stays at 70 or below unless you ran a test here or quote that build's own source or docs. Upstream documentation does not prove what a vendor build does.
4. A claim says no more than its proof shows: if the test ran on one build, the claim names that build; if the quote covers one case, the claim covers that case.
5. Untagged prose may only restate tagged claims. Any new fact in the body gets its own `[NN%]` and proof.
6. Before you finish, re-read every claim at 80 or above and check that its proof states exactly that claim. Lower the number, or run the check, when it does not.
7. When a primary source settles a fact, state it at the proof's level; do not leave it as [unconfirmed]. Use a low number only for facts you could not reach.
CLAIMS LEDGER: end the report with a section "Claims ledger": the 10 to 15 claims a reader would act on, highest stakes first, each in the format of rule 1, followed by ` verify: <a URL or a command that re-checks it in under a minute>`.

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
- **Mixed-model parallel** follows **Model routing**: Haiku at `xhigh` for web angles, Sonnet with METHOD for angles that dig into source code, both in the same fan-out.

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
