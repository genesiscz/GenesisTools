# Fix Summarize Truncation: Balanced Priority + Model-Aware Chunking

## Context

The `balanced` priority mode in `tools claude history summarize` fills chronologically from the start and stops when the token budget is exhausted. For long sessions (13K+ messages), the middle and end — where results, benchmarks, and conclusions live — are never seen by the LLM. It hallucinates data it never received.

**Root causes:**
1. `balanced` is just `[...this._messages]` iterated sequentially, stopping at budget
2. `--prompt-only` returns before `--thorough` chunking runs
3. `--thorough` still applies the default 128K extraction budget before chunking — defeating the purpose
4. Chunk size is hardcoded at 100K — should derive from the model's context window with answer space reserved

---

## Critical Files

| File | Role |
|------|------|
| `src/utils/claude/session.ts` | `toPromptContent()` — truncation algorithm |
| `src/claude/lib/history/summarize/engine.ts` | Extraction, chunking, LLM calls |
| `src/claude/commands/summarize.ts` | CLI → SummarizeOptions mapping |

---

## Task 1: Redesign `balanced` priority to be summary-aware ✅ DONE

**Commit:** `1808bd87`

3-tier algorithm: Bookends + summaries (always) → recent post-summary (70%) → early context (30%). Reassembled chronologically. Truncation info: `Included X of Y (balanced: N summaries + M recent + K early)`.

---

## Task 2: Fix `--prompt-only` + `--thorough` ✅ DONE

**Commit:** `1808bd87`

`--prompt-only` now shows chunk structure when `--thorough` is set.

---

## Task 3: Add `--priority summary-first` ✅ DONE

**Commit:** `1808bd87`

Same algorithm as balanced but 85/15 split favoring recent context.

---

## Task 5: `--thorough` extracts everything + model-aware chunk sizing

### 5.1: Make `SummarizeOptions.tokenBudget` optional

**File:** `engine.ts`

Change type from `number` to `number | undefined`. In `extractContent()`:
- No explicit budget + `--thorough`: use `Infinity` (extract all, chunking handles volume)
- No explicit budget + normal: use `128_000`
- Explicit `--max-tokens`: always use that value

### 5.2: Fix `summarize.ts` to only pass budget when explicitly set

**File:** `summarize.ts`

Both `runInteractiveFlow` return and `buildNonInteractiveOptions`:
- `explicitTokenBudget = opts.maxTokens ? parseInt(...) : undefined`
- Preview call: `previewBudget = explicitTokenBudget ?? 128_000`
- Engine options: `tokenBudget: explicitTokenBudget`

### 5.3: Derive chunk size from model context window

**File:** `engine.ts` — modify `runChunkedSummarization()`

The chunk size should fit within the model's context window minus system prompt and output space:

```typescript
const contextWindow = providerChoice.model.contextWindow;
const systemOverhead = 2_000; // system prompt ~2K tokens
const outputReserve = Math.floor(contextWindow * 0.2); // 20% for answer
const safetyMargin = Math.floor(contextWindow * 0.05); // 5% safety
const chunkSize = contextWindow - systemOverhead - outputReserve - safetyMargin;
```

Results by model:
- Claude Sonnet 4 (200K): ~146K chunk
- GPT-4o (128K): ~89K chunk
- Small models (32K): ~22K chunk

Fallback when `contextWindow` is 0 or unavailable: `100_000` (current hardcoded value).

### 5.4: Pass `maxTokens` to LLM calls in chunked mode

**File:** `engine.ts` — modify `callLLM()`

Add optional `maxTokens` parameter. For chunked mode, pass `outputReserve` so the model knows its output budget:

```typescript
const result = await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    maxTokens, // explicit output budget when chunking
});
```

### 5.5: Update `--prompt-only --thorough` to show model-derived chunk info

```
=== THOROUGH MODE: 3 chunks (model: claude-sonnet-4, context: 200K, chunk: ~146K) ===
```

---

## Task 6: Create `genesis-tools:summarize` skill

**File:** `plugins/genesis-tools/skills/summarize/SKILL.md` (NEW)

### Trigger description

Use when user wants to summarize a Claude Code session, extract learnings, create documentation, generate a changelog/postmortem, or analyze past work. Triggers on: "summarize this session", "extract learnings", "write up what we did", "create onboarding docs", "what changed", "postmortem", "remember this for later".

### Skill behavior flow

**Step 1: Parse user intent from args.** If the user wrote something after the slash command, infer params:

| User says | Inferred |
|-----------|----------|
| "document", "docs", "write up" | `--mode documentation` |
| "remember", "memory", "memorize" | `--mode memorization` |
| "short", "brief", "tldr", "quick" | `--mode short-memory` |
| "changelog", "what changed" | `--mode changelog` |
| "debug", "postmortem", "what went wrong" | `--mode debug-postmortem` |
| "onboard", "explain to new dev" | `--mode onboarding` |
| "learnings", "benchmarks", "findings" | `--mode learnings` |
| "extract X", "find all Y", "list Z" | `--mode custom --custom-prompt "..."` |
| "this session", "current", "what we just did" | `--current` |
| "last session", "yesterday" | `--since "yesterday"` |
| mentions a session ID or partial | positional arg |

**Step 2: Show inferred params + ask numbered questions for gaps.**

Each question gets short lettered options the user can answer quickly:

```
Based on what you said, here's what I'll use:
- Session: current ($CLAUDE_CODE_SESSION_ID)
- Mode: learnings

I need a few more details:

1. Output destination?
   a) Terminal only (default)
   b) Write to file — I'll suggest a path
   c) Clipboard
   d) Apple Notes

2. This session has ~15K messages. Use thorough mode?
   a) Yes — process everything via chunking (slower, more complete)
   b) No — 128K budget with smart truncation (faster)

3. Include tool execution results?
   a) No (default — lighter, focuses on conversation)
   b) Yes — capture command outputs and file contents
```

Only ask questions where the answer isn't obvious from context. Skip questions with clear defaults for simple requests.

**Step 3: Build and run the command.** Construct the full command, show it, execute.

**Step 4: Offer to write output.** After the tool runs:
- If output was to terminal → offer: "Save this to a file? Suggested: `.claude/plans/YYYY-MM-DD-<topic>.md` or `docs/<topic>.md`"
- If mode was `memorization` without `--memory-dir` → offer to split into topic files

### Complete param reference (embedded in SKILL.md)

The skill must contain a full deep reference so Claude can explain any param to the user. Every section below goes into the SKILL.md verbatim.

#### Session Selection

| Option | Description |
|--------|-------------|
| `[session-id]` | Session UUID or prefix (min 8 chars). Use `tools claude history -i` or `tools claude history "keyword"` to find IDs |
| `-s, --session <id>` | Repeatable — process multiple sessions sequentially |
| `--current` | Use `$CLAUDE_CODE_SESSION_ID` (only works inside a Claude Code session) |
| `--since <date>` | Sessions after date. Accepts: "7 days ago", "yesterday", "2026-03-01", ISO timestamps |
| `--until <date>` | Sessions before date. Same formats as --since |
| `-i, --interactive` | Guided flow: session picker → mode picker → model picker → preview → confirm |

**Resolution order:** positional arg → `--session` → `--current` → `--since/--until` → interactive picker (TTY) → error (non-TTY)

#### Modes (`-m, --mode`)

| Mode | Output style | When to use |
|------|-------------|-------------|
| `documentation` (default) | Full technical doc: problem, changes by file, code patterns, architecture decisions, lessons | Long-term reference, handoff docs |
| `memorization` | Knowledge entries organized by topic tags `[architecture]`, `[debugging]`, `[pattern]`, `[gotcha]`, `[config]`, `[api]`, `[performance]`, `[testing]` | Building a knowledge base; use with `--memory-dir` to split into per-topic files |
| `short-memory` | Concise 500-2000 char bullet points under topic headers | Quick reference for MEMORY.md or project notes |
| `changelog` | Added/Changed/Fixed/Removed with file paths (Keep a Changelog format) | Release notes, team updates |
| `debug-postmortem` | Symptoms → investigation timeline → dead ends (with WHY they failed) → root cause → fix → prevention | After long debugging sessions; prevents repeating the same investigation |
| `onboarding` | Architecture overview, key files, data flow, common operations, conventions, gotchas | Onboarding new devs to a codebase area |
| `learnings` | Benchmarks table (metric/value/context/notes), key findings, config changes, actionable items, gotchas | Capturing quantified results, before/after comparisons, findings |
| `custom` | User-defined via `--custom-prompt` | Any analysis: "list all API endpoints", "extract all error messages", etc. |

#### Priority Modes (`--priority`)

Controls which messages are kept when the session exceeds the token budget.

**`balanced` (default)** — Summary-aware, 3-tier system:
- **Tier 1 (always included):** First message + last message (bookends) + ALL compaction summary messages. Summaries are high-density knowledge created by Claude itself during context compaction.
- **Tier 2 (70% of remaining budget):** Messages AFTER the last compaction summary. These are recent, unsummarized work — where conclusions, benchmarks, and final results live. Filled backwards from the end (most recent first).
- **Tier 3 (30% of remaining budget):** Everything else — early context and messages between summaries. Filled forward from message #2.
- All included messages reassembled in chronological order for the LLM.
- If no summaries exist: falls back to 70% last messages / 30% first messages.
- Truncation info: `Included X of Y (balanced: N summaries + M recent + K early)`

**`summary-first`** — Same 3-tier system but 85/15 split: 85% budget to recent context, 15% to early. Use when you know the important stuff is at the end.

**`user-first`** — All user messages first, then assistant, then other. No summary awareness. Preserves user intent over assistant reasoning.

**`assistant-first`** — All assistant messages first, then user, then other. Preserves assistant findings/reasoning over user prompts.

#### Content Inclusion

| Option | Default | What it adds |
|--------|---------|-------------|
| `--include-tool-results` | off | Tool execution results (command outputs, file contents). Can significantly increase token count. |
| `--include-thinking` | off | Claude's thinking/reasoning blocks. Very token-heavy — use sparingly. |

#### Token Budget (`--max-tokens`)

Default: `128,000` tokens. Controls how much of the session transcript is extracted. Uses `~4 chars/token` estimate. When exceeded, the priority mode determines what gets cut.

#### Thorough Mode (`--thorough`)

For sessions too large to fit in a single LLM context window. Two-phase process:
1. **Phase 1:** Extracts ALL messages (ignores token budget). Splits content into chunks sized to the model's context window (minus system prompt + output space). Each chunk summarized by the LLM independently.
2. **Phase 2:** All chunk summaries combined and passed through the selected template for a final synthesis pass.

Use when: session has thousands of messages, or you're getting truncation warnings with important content missing.

#### Output Destinations

| Option | Behavior |
|--------|----------|
| (none) | Print to terminal (streamed in real-time on TTY) |
| `-o, --output <path>` | Write to file (creates parent dirs). Can combine with other targets. |
| `--clipboard` | Copy to clipboard silently |
| `--apple-notes` | Save to Apple Notes (interactive folder picker) |
| `--memory-dir <path>` | Only with `--mode memorization`: splits output by `## [topic]` headers into separate `{topic}.md` files |

All targets can be combined (e.g., `--output file.md --clipboard`).

#### LLM Selection

| Option | Description |
|--------|-------------|
| `--provider <name>` | LLM provider: anthropic, openai, openrouter, etc. |
| `--model <name>` | Model ID: claude-sonnet-4-20250514, gpt-4o, etc. |
| `--prompt-only` | Output the prepared prompt without calling an LLM. Useful for debugging or piping to another tool. With `--thorough`, shows chunk structure. |

#### Message Formatting in Transcripts

The tool formats session messages as:
```
[User]: <text>
[Assistant]: <text>
[Tool: ToolName] <file-path>
[Tool Result]: <text>        (only with --include-tool-results)
[Thinking]: <text>           (only with --include-thinking)
[Summary]: <compaction text>
[Subagent]: <text>
[PR Link]: <url>
```

### Example invocations

```
# User: "/genesis-tools:summarize extract learnings from this session"
→ Infer: --current --mode learnings
→ Ask: output destination? thorough?

# User: "/genesis-tools:summarize"
→ No intent → ask all: which session? which mode? output?

# User: "/genesis-tools:summarize write onboarding docs for session abc123"
→ Infer: abc123 --mode onboarding --output docs/onboarding.md
→ Ask: include tool results? thorough?
```

---

## Task 7: Commit and verify

```bash
git commit -m "fix(claude): model-aware chunk sizing for --thorough summarization"
```

**Verification:**
```bash
# 1. Thorough extracts everything (no truncation)
tools claude history summarize 19319e91 \
  --prompt-only --thorough 2>&1 | grep -E "truncat|Included|All"

# 2. Chunk size derived from model
tools claude history summarize 19319e91 \
  --prompt-only --thorough 2>&1 | grep "THOROUGH"

# 3. Normal mode still defaults to 128K
tools claude history summarize 19319e91 \
  --prompt-only 2>&1 | head -20

# 4. Explicit --max-tokens overrides thorough
tools claude history summarize 19319e91 \
  --prompt-only --thorough --max-tokens 50000 2>&1 | grep "truncat"
```
