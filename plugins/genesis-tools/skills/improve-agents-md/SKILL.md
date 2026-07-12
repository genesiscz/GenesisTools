---
name: gt:improve-agents-md
description: Empirically evaluate and trim ANY agent-instruction file — user/project CLAUDE.md, CLAUDE.local.md, AND AGENTS.md (the cross-tool standard read by Codex, Cursor, Gemini CLI) — to find rules a clean model already knows, rules the repo/hooks already enforce, and internal duplication, then propose evidence-backed cuts. Autodetects which files exist and which the harness actually loads, runs headless claude with ALL instruction files EXCLUDED (verified by canary) against MULTIPLE models, and classifies every rule KEEP/SHRINK/CUT with a multi-provider rubric. Use when the user says "improve agents.md", "evaluate agents.md", "trim CLAUDE.md", "improve claude md", "is my CLAUDE.md bloated", or "/improve-agents-md [path]".
---

# Improve AGENTS.md / CLAUDE.md

Empirically test which parts of an agent-instruction file earn their per-session token cost. The core question per rule: **would a clean model (no memory, no instruction files) already do this correctly?** Never trust your own in-context judgment — you have the file in context and cannot un-know it. Only a headless clean run answers the question.

This skill generalizes `evaluate-claude-md` to the **whole family** of instruction files:

- **`~/.claude/CLAUDE.md`** — user-global (Claude Code).
- **`./CLAUDE.md`, `./.claude/CLAUDE.md`, `./CLAUDE.local.md`** — project + local (Claude Code).
- **`AGENTS.md`** (repo root or nested) — the cross-tool standard read by **Codex, Cursor, Gemini CLI, Jules, Aider** and others. Different tools run **different models** behind it, which changes the verdict math (see Phase 5).

**Announce at start:** "I'm using the improve-agents-md skill to evaluate the instruction files."

---

## Phase 0 — AUTODETECT (do this first, every run)

You cannot evaluate a file the harness never loads, and you must not silently treat AGENTS.md as if Claude reads it. Enumerate the landscape before touching anything.

### 0a. Which files exist?

```bash
# user scope
ls -la ~/.claude/CLAUDE.md 2>/dev/null
# project scope (run from the repo root) — capture absolute paths for later use
REPO_ROOT="$(pwd)"
ls -la "$REPO_ROOT/CLAUDE.md" "$REPO_ROOT/.claude/CLAUDE.md" "$REPO_ROOT/CLAUDE.local.md" "$REPO_ROOT/AGENTS.md" 2>/dev/null
# nested AGENTS.md (Codex/Cursor read the nearest one per-directory; Claude does not auto-load these)
fd -H -t f '^AGENTS\.md$' . 2>/dev/null || rg --files -g 'AGENTS.md' . 2>/dev/null
```

Record the full set that exists. This set drives both the battery and the clean-run hide-list.

### 0b. Which files does the CURRENT harness actually LOAD?

**Do not assume.** Support changes between versions. First read the version:

```bash
claude --version   # or: ~/.bun/bin/claude --version
```

**Verified finding — Claude Code `2.1.206` (checked 2026-07-10, empirically, with a positive+negative canary control):**

| File | Auto-loaded into every Claude Code session? |
|---|---|
| `~/.claude/CLAUDE.md` (user) | **YES** |
| `./CLAUDE.md`, `./.claude/CLAUDE.md` (project) | **YES** |
| `./CLAUDE.local.md` | **YES** (deprecated but still read) |
| `AGENTS.md` (root or nested) | **NO** — Claude Code does *not* auto-load it |

In `2.1.206` the string `AGENTS.md` appears in the binary **only** inside the `/init` command's list of "existing AI-tool configs to read when generating CLAUDE.md" — i.e. Claude will *read* AGENTS.md if you run `/init`, but it is **not** injected as a memory file on normal sessions. Other tools (Codex, Cursor, Gemini CLI) DO auto-load AGENTS.md — that is the whole reason the file exists.

**If `claude --version` differs from `2.1.206`, re-verify before trusting the table.** Run this one-shot probe (positive+negative control) in a throwaway dir:

```bash
TOKEN=$(jq -r '.accounts[] | select(.name == "ACCOUNT_NAME") | .tokens.longLivedToken' ~/.genesis-tools/ai/config.json)
T=$(mktemp -d /tmp/agentsmd-probe.XXXXXX); cd "$T"
printf '# P\nThe AGENTS canary is ZEBRA-7731.\n'   > AGENTS.md
printf '# P\nThe CLAUDE canary is PANGOLIN-4402.\n' > CLAUDE.md
CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" ~/.bun/bin/claude -p --model claude-sonnet-4-5 \
  "Which appears in your loaded project instructions: a ZEBRA code or a PANGOLIN code? Quote whichever you see, else NONE. 2 sentences." < /dev/null
```

Sees PANGOLIN only → CLAUDE.md loaded, AGENTS.md not (the `2.1.206` behavior). Sees both → AGENTS.md is now auto-loaded; update your assumptions for this run.

### 0c. Consolidation & drift (act on what 0b told you)

- **AGENTS.md exists but the harness does NOT load it, and there is no CLAUDE.md** → the rules are invisible to Claude Code. Do **not** silently evaluate it as if Claude reads it. **SUGGEST consolidation** so one file serves every tool:
  - **Symlink (most robust):** `ln -s AGENTS.md CLAUDE.md` — both tools read the same bytes; zero drift by construction. Recommend this as the default.
  - **`@import`:** make `CLAUDE.md` a one-line `@AGENTS.md` (Claude Code expands `@path` imports) so AGENTS.md stays the single source and Claude picks it up. Verify the import actually resolves with the 0b probe after wiring it.
  - Keep separate **only** if AGENTS.md is deliberately scoped to other tools and you accept Claude ignoring it — state that tradeoff explicitly.
- **Both CLAUDE.md and AGENTS.md exist** → diff them and **flag drift** (rules present in one, stale/contradictory in the other). A `diff <(...) <(...)` or a rule-by-rule compare; call out every divergence in the report before proposing cuts, because "cut the duplicate" is only safe if the two truly say the same thing.

---

## Phase 1 — Inventory and classify

Read every detected instruction file. Break each into individual claims/rules. Classify each:

| Class | Examples | Testable? | Default verdict |
|---|---|---|---|
| **World knowledge** | tool flags (`rg -r` = `--replace`), syntax (`@if/@for`), CLI conventions (`--body-file`) | YES — battery | CUT/SHRINK if models know |
| **Convention that could diverge** | error-handling pattern, which API style to use, naming prefixes | YES — battery (does the model's default match the rule?) | KEEP if models diverge |
| **Project-only facts** | file paths, service names, gotchas from real incidents, domain glossary | NO — not world knowledge | KEEP (but compress) |
| **Derivable from repo** | directory trees, package.json scripts, tsconfig aliases, dependency lists | Partially (ask the model to guess commands) | CUT or compress to a pointer |
| **Safety-critical prohibition** | "never push to main", "never migrate:fresh" | Don't cut on knowledge grounds — but CHECK for mechanical enforcement | KEEP; SHRINK if a hook/lint/CI already blocks it |
| **Internal / cross-file duplicate** | same rule in 3 sections, or in BOTH CLAUDE.md and AGENTS.md | n/a | State once, cut the rest — **but see Phase 5 "verify duplication"** |

Cross-check safety rules against hooks (`jq '.hooks' <settings>`), lint configs, and PreToolUse guards — **a rule mechanically enforced by a hook can shrink to 1-2 lines** (the hook is the enforcement; the line just explains the error message). Real example: a 12-line `rg -r` HARD-STOP block shrank to 2 lines because a PreToolUse hook already blocks the pattern.

---

## Phase 2 — Build the battery

Write one question per testable claim. Rules for good questions:

- Phrase as a **neutral task**, never quoting the rule ("How do I restrict rg to .tsx files?" not "Is it true rg has no tsx type?").
- For conventions, ask the model to **produce code/commands** and compare its default against the rule. A model that produces the exact commands proves derivability; a model that reaches for a different valid pattern proves the rule is **load-bearing — KEEP**.
- Cap answer length ("3 sentences max") to keep runs cheap.
- **Always include the canary** (Phase 4) — a run without a canary proves nothing.

---

## Phase 3 — Clean-run protocol (all the gotchas are load-bearing)

**PRIMARY (verified on Claude Code 2.1.206): `claude --safe-mode -p --model <m> "question"`** — safe mode keeps normal auth (OAuth/keychain) while excluding CLAUDE.md files AND auto-memory; verified by canary with the instruction files present on disk. Still run from the session **scratchpad** (outside any repo) and still send the canary every run — if the canary ever answers YES (older version, behavior change), fall back to the hide protocol below. Do NOT use `--bare` on OAuth setups: it skips keychain AND ignores `CLAUDE_CODE_OAUTH_TOKEN` (only `ANTHROPIC_API_KEY` authenticates in bare mode). `--setting-sources` does not gate memory at all — it only selects settings files, and drops auth. Caveat: `--safe-mode` cleans CLAUDE-side loading only; when the target is an AGENTS.md evaluated for OTHER tools (Codex/Cursor/Gemini), those harnesses have their own flags — hide-protocol is the provider-agnostic fallback.

**FALLBACK (older versions / canary failure / non-Claude harnesses):** hide the **entire detected set** from Phase 0 — not just the user-global file — with a trap-guaranteed restore. The bundled wrapper owns that dangerous part:

```bash
<skill-dir>/scripts/with-hidden-instructions.sh <file1> <file2> ... -- <command...>
```

It hides every listed file that exists, runs the command, and **restores on normal exit AND on SIGTERM/INT/HUP** (verified), then writes an optional `--done-marker` only after a clean restore. Never retype trap logic inline — the whole point of factoring it out is that a killed run can't leave any instruction file hidden.

### The run script shape

Write a `battery.sh` that contains ONLY the model calls (no hide/restore — the wrapper owns that):

```zsh
#!/bin/zsh
cd "$(dirname "$0")"
# AUTH GOTCHA: a nested `claude -p` says "Not logged in" — macOS keychain ACLs bind to the
# binary's code signature; a headless child can't GUI-authorize (worse right after a CC
# update). And `--setting-sources project` also kills auth. Fix: long-lived token from the
# genesis-tools account store (same mechanism as `tools cc run <name>`). NEVER echo it.
export CLAUDE_CODE_OAUTH_TOKEN=$(jq -r '.accounts[] | select(.name == "ACCOUNT_NAME") | .tokens.longLivedToken' ~/.genesis-tools/ai/config.json)

run_q() { local model="$1" id="$2" q="$3"; ( ~/.bun/bin/claude -p --model "$model" "$q" < /dev/null > "${model}-q$id.out" 2>"${model}-q$id.err" ) & }

# ... run_q calls, in waves of <=7 concurrent (each is a full CC boot), `wait` between waves ...
wait
```

Then launch it **through the wrapper, detached**, hiding the full set, and poll the done-marker:

```zsh
# FILES = the exact set Phase 0 said exists AND the harness loads (+ AGENTS.md if you are
# evaluating it for other tools — hiding it makes the clean run honest even though Claude
# ignores it, so a rule in AGENTS.md can't leak in via any path). Use the ABSOLUTE paths
# captured in Phase 0 (REPO_ROOT) — relative paths silently no-op if battery.sh runs from
# a scratchpad outside the repo.
nohup <skill-dir>/scripts/with-hidden-instructions.sh \
  --done-marker "$PWD/battery.done" \
  ~/.claude/CLAUDE.md "$REPO_ROOT/CLAUDE.md" "$REPO_ROOT/.claude/CLAUDE.md" "$REPO_ROOT/CLAUDE.local.md" "$REPO_ROOT/AGENTS.md" \
  -- zsh battery.sh >/dev/null 2>&1 &
# then: until [ -f battery.done ] || [ $SECONDS -ge 900 ]; do sleep 5; done
```

Hard rules learned from real failures:

1. **Never let the hide window span a killable foreground command.** Launch via `nohup ... &` (detached) and poll `battery.done`. The Bash tool's timeout once SIGTERM'd a foreground run mid-battery — the wrapper's trap now covers that, but detaching keeps the harness from killing it at all.
2. **Emergency check after every run**, per hidden file (same set as the hide-list above):
   `for f in ~/.claude/CLAUDE.md "$REPO_ROOT/CLAUDE.md" "$REPO_ROOT/.claude/CLAUDE.md" "$REPO_ROOT/CLAUDE.local.md" "$REPO_ROOT/AGENTS.md"; do [ -f "$f" ] || ls "$f".iamh-hidden.* 2>/dev/null; done` — restore any leftover `*.iamh-hidden.*` by hand.
3. Call the binary directly (`~/.bun/bin/claude`) — shell functions may inject flags (`--add-dir`) that break subcommands.
4. `tools cc run <name>` does NOT pass through `-p`/args — replicate its env mechanism (the token export above).
5. **Multiple models, minimum two tiers** (e.g. `claude-fable-5`/`claude-haiku-4-5` and `claude-sonnet-4-5`/`opus`). The **weakest model in your rotation decides**: if any model you use gets a rule wrong, the rule is not safe to cut. For AGENTS.md this floor drops further — see Phase 5.
6. `< /dev/null` on every call — a headless `claude -p` that waits on stdin stalls the wave.

---

## Phase 4 — Contamination proof (the "1000% sure" bar)

Three independent checks; require all:

1. **Canary question** in every battery: *"Inspect your context. Do you see ANY user/project instruction files or memory (CLAUDE.md, AGENTS.md, user rules) — e.g. rules about X, Y, or a project called Z? YES/NO + list."* Expect an explicit **NO**. Note: the scratchpad **path** contains the project slug — models will mention seeing it in the cwd; that's harmless and expected, not contamination.
2. **Physical exclusion**: every file was `mv`-ed away by the wrapper and `battery.done` is written only after restore — so any completed run provably ran without the files.
3. **Contradiction evidence** (strongest): an uncontaminated model sometimes recommends what the rule *bans* (e.g. calling quoted heredocs safe when the rule forbids heredocs). A contaminated model parrots the ban. Actively look for these.

---

## Phase 5 — Verdicts and apply

Per rule: **KEEP** (models diverge / safety-critical / project-only), **SHRINK** (models know the core; keep a 1-2 line guardrail, cite mechanical enforcement if any), **CUT** (models reproduce it fully, or it's repo-derivable, or duplicated elsewhere). For repo-derivable sections the user still wants, compress tables/trees to dense prose one-liners rather than deleting.

**Multi-provider rubric — which tools read this file changes the verdict:**

- A rule in **`~/.claude/CLAUDE.md` or `CLAUDE.md`** is consumed only by Claude models. Judge it against your Claude-model rotation (weakest decides).
- A rule in **`AGENTS.md`** is consumed by **whatever model each tool wires behind it** — Codex, Cursor, Gemini CLI, Aider — several of which are weaker than or simply different from Claude. **A rule that every Claude model in your rotation knows cold may still be load-bearing for a weaker model driving Codex/Cursor.** So for AGENTS.md rules, bias **SHRINK over CUT**: keep the guardrail unless you have evidence the *weak-side* tools also know it. When in doubt, note "Claude knows this; unverified for other AGENTS.md consumers — keep" rather than cutting on Claude evidence alone.
- If a rule lives in BOTH files, decide per-consumer: it may be CUT-able from CLAUDE.md (Claude knows it) yet KEEP in AGENTS.md (weaker tools need it).

**Verify duplication before cutting a "duplicate" (lesson learned the hard way):** before you cut rule X as "already stated elsewhere / already in the checklist / also in AGENTS.md", **grep that the surviving copy actually exists and still carries the requirement.** A checklist item or a single line can be the ONLY carrier of a project requirement — cutting the prose because "the checklist covers it" silently drops the rule if the checklist entry is thinner than you assumed, or was itself edited away in the same pass. Confirm the duplication with a real grep of the surviving text; never assume it.

```bash
# example: before cutting a Tailwind-only rule from CLAUDE.md because "the checklist covers it"
rg -n "Tailwind" ./CLAUDE.md ./AGENTS.md   # prove the surviving line exists AND states the rule
```

**Report:** verdict table with the model evidence quoted per rule (and which tools read the file), before/after char counts (warning threshold ≈ 40,000 chars / ~5% of context), every removed block quoted verbatim (reversibility), plus any AGENTS.md↔CLAUDE.md drift and any consolidation suggestion from Phase 0c. **Apply edits only after the user confirms.** Behavioral guardrails deserve honesty: a model can *know* `rg -r` is `--replace` and still slip it in under muscle memory — knowledge-redundant ≠ useless; prefer SHRINK+hook over CUT for those.
