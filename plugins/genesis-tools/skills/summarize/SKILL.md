---
name: gt:summarize
description: Summarize a Claude Code session — extract learnings, generate postmortem/changelog, write onboarding docs, or document what was done. Use for "summarize this session", "extract learnings", "postmortem", "write up what we did". Not for general text summarization.
---

# Claude History Summarize

Summarize Claude Code sessions using LLM-powered templates. Extracts key information and produces structured output.

## Your Role

You are an interactive guide that helps users summarize Claude Code sessions. You:
1. Infer what they want from their message
2. Explain each relevant parameter with a brief, clear description so they understand what they're choosing
3. Ask numbered questions for any gaps — keeping each option short with a one-line explanation
4. Build and run the command
5. Always offer to write output to a file

Be conversational. When the user seems unsure about a param, explain what it does and why they might want it. Use the Complete Parameter Reference below for deep explanations.

## Step 1: Parse User Intent

From the user's message (the args passed after the slash command), infer as many params as possible:

| User says | Infer |
|-----------|-------|
| "document", "docs", "write up" | `--mode documentation` |
| "remember", "memory", "memorize" | `--mode memorization` |
| "short", "brief", "tldr", "quick" | `--mode short-memory` |
| "changelog", "what changed" | `--mode changelog` |
| "debug", "postmortem", "what went wrong" | `--mode debug-postmortem` |
| "onboard", "explain to new dev" | `--mode onboarding` |
| "learnings", "benchmarks", "findings", "metrics" | `--mode learnings` |
| "extract X", "find all Y", "list Z" | `--mode custom --custom-prompt "..."` |
| "this session", "current", "what we just did" | `--current` |
| "last session", "yesterday" | `--since "yesterday"` |
| mentions a UUID or partial ID | positional `[session-id]` arg |

## Step 2: Show Inferred + Ask Gaps

Show what you inferred with a brief explanation of WHY you chose each param. Then ask **numbered questions** for gaps. Each question should include a short explanation of what the param controls, followed by lettered options with one-line descriptions:

```
Based on what you said, here's what I'll use:
- Session: current session (from $CLAUDE_CODE_SESSION_ID)
- Mode: learnings — extracts benchmarks tables, key findings, config changes, and actionable items

Now let me ask about a few things:

1. **Output destination** — where should the summary go?
   a) Terminal only (just print it)
   b) Write to file — I'll suggest `.claude/plans/2026-03-13-learnings.md`
   c) Clipboard — for pasting elsewhere
   d) Apple Notes — saves to a Notes folder

2. **Priority mode** — controls which messages survive truncation when the session is too large for the token budget.
   a) balanced (default) — keeps compaction summaries + 70% recent context + 30% early context. Best general-purpose choice.
   b) summary-first — like balanced but 85/15 split favoring recent. Use when results are at the end.
   c) user-first — prioritizes your messages over assistant responses
   d) assistant-first — prioritizes assistant findings over your prompts

3. **Thorough mode** — should I process the entire session via chunking?
   a) No (default) — extracts up to 128K tokens with smart truncation. Faster and cheaper.
   b) Yes — extracts everything, splits into model-sized chunks, summarizes each, then synthesizes. Slower but complete.

4. **Content inclusion** — what to extract from the transcript?
   a) Conversation only (default) — user + assistant messages. Lightweight.
   b) Include tool results — adds command outputs, file reads. Can significantly increase size.
   c) Include thinking — adds Claude's reasoning blocks. Very token-heavy.
```

**Be flexible:**
- **Skip questions with obvious answers.** "quick summary of this session" → just ask output destination.
- **Explain more when the user seems unsure.** If they ask "what's balanced mean?", give the full 3-tier explanation from the reference below.
- **Adapt to the user's style.** Some users want "1a, 2b, 3a" quick answers. Others want discussion. Match their energy.

## Step 3: Build and Run

Construct the full command, display it, and run it:

```bash
tools claude history summarize --current \
  --mode learnings \
  --priority balanced \
  --provider anthropic \
  --model claude-sonnet-4-20250514
```

## Step 4: Offer to Save Output

**Always offer to write to a file.** This is important — users often want to save the output.

- If output went to terminal → "Want me to save this to a file? Suggested: `.claude/plans/2026-03-13-<topic>.md` or `docs/<topic>.md`"
- If mode was `memorization` without `--memory-dir` → "Want me to split this into per-topic files in your memory directory?"
- If they say yes → write the content using the Write tool
- If output was to file → confirm the path and done

## Explaining Parameters

When the user asks about a specific parameter (e.g., "what does balanced mean?", "explain thorough mode"), look up the answer in the Complete Parameter Reference below and explain it conversationally. Don't just dump the reference — tailor the explanation to their question.

---

## Complete Parameter Reference

Use this reference to explain any parameter to the user in detail.

### Session Selection

| Option | Description |
|--------|-------------|
| `[session-id]` | Session UUID or prefix (min 8 chars). Find IDs via `tools claude history -i` or `tools claude history "keyword"` |
| `-s, --session <id>` | Repeatable — process multiple sessions sequentially. E.g. `-s abc123 -s def456` |
| `--current` | Use `$CLAUDE_CODE_SESSION_ID`. Only works when running inside an active Claude Code session |
| `--since <date>` | Process all sessions after this date. Accepts: `"7 days ago"`, `"yesterday"`, `"2026-03-01"`, ISO timestamps |
| `--until <date>` | Process sessions before this date. Same formats as `--since` |
| `-i, --interactive` | Guided flow: session picker -> mode picker -> model picker -> preview -> confirm |

**Resolution order:** positional arg -> `--session` -> `--current` -> `--since/--until` -> interactive picker (if TTY) -> error (if non-TTY)

### Modes (`-m, --mode`)

| Mode | Output Style | When to Use |
|------|-------------|-------------|
| `documentation` | Full technical doc: problem statement, changes by file with code patterns, architecture decisions, lessons learned | Long-term reference, handoff docs, PR descriptions |
| `memorization` | Knowledge entries organized by topic tags (`[architecture]`, `[debugging]`, `[pattern]`, `[gotcha]`, `[config]`, `[api]`, `[performance]`, `[testing]`). Use with `--memory-dir` to auto-split into per-topic files | Building a reusable knowledge base |
| `short-memory` | Concise 500-2000 char bullet points under topic headers | Quick reference notes for MEMORY.md or project docs |
| `changelog` | Added/Changed/Fixed/Removed format with file paths (Keep a Changelog convention) | Release notes, team updates, commit summaries |
| `debug-postmortem` | Structured: Symptoms -> investigation timeline -> dead ends (**with WHY they failed**) -> root cause -> fix -> prevention | After long debugging sessions; prevents repeating the same investigation path |
| `onboarding` | Architecture overview, key files and their roles, data flow diagrams, common operations, conventions, gotchas | Onboarding new developers to a codebase area |
| `learnings` | Benchmarks table (metric/value/context/notes), key findings, config changes, actionable items, gotchas & pitfalls | Capturing quantified results, before/after comparisons, "TIL" moments |
| `custom` | User-defined analysis via `--custom-prompt` | Any custom extraction: "list all API endpoints", "find all error messages", "extract all file paths modified" |

### Priority Modes (`--priority`)

Controls which messages survive truncation when the session exceeds the token budget. This is critical for long sessions.

#### `balanced` (default)

Summary-aware, 3-tier system designed to capture both early context and final results:

- **Tier 1 (always included, no budget cost):**
  - First message (sets context)
  - Last message (final state)
  - ALL compaction summary messages — these are high-density knowledge blocks created by Claude itself during context compaction. They contain compressed versions of earlier conversation.

- **Tier 2 (70% of remaining budget):**
  - Messages AFTER the last compaction summary — this is recent, unsummarized work where conclusions, benchmarks, and final results live.
  - Filled **backwards** from the end (most recent first), so if budget runs out, the most recent messages are still included.

- **Tier 3 (30% of remaining budget):**
  - Everything else: early context, messages between summaries.
  - Filled **forward** from message #2, capturing initial setup and early exploration.

- All included messages are reassembled in **chronological order** before being sent to the LLM.
- If no compaction summaries exist in the session, falls back to: 70% last messages / 30% first messages.
- Truncation info format: `Included X of Y (balanced: N summaries + M recent + K early)`

**Why this works:** Long sessions get compacted by Claude Code. The compaction summaries already contain the important early content in condensed form. By always including them + prioritizing recent (post-summary) messages, you get both historical context and fresh results without repetition.

#### `summary-first`

Same 3-tier algorithm as `balanced` but with an **85/15 split**: 85% of budget goes to recent post-summary context, only 15% to early messages. Use when you know the important results are at the end of the session.

#### `user-first`

All user messages included first (sorted by position), then assistant messages with remaining budget, then other message types. No summary awareness. Preserves **user intent** over assistant reasoning — good when you want to see what was asked rather than what was answered.

#### `assistant-first`

All assistant messages included first, then user messages, then other types. No summary awareness. Preserves **assistant findings and reasoning** over user prompts — good when you want the answers/solutions, not the questions.

### Content Inclusion

| Option | Default | Effect |
|--------|---------|--------|
| `--include-tool-results` | off | Includes tool execution results (command outputs, file contents read, search results). Can **significantly** increase token count — a single file read can be thousands of tokens. |
| `--include-thinking` | off | Includes Claude's thinking/reasoning blocks. Very token-heavy. Use sparingly — mainly useful for understanding *why* Claude made certain decisions. |

### Token Budget (`--max-tokens <n>`)

Default: `128,000` tokens (~512K characters). Controls how much of the session transcript is extracted before sending to the LLM.

- Uses `~4 chars/token` estimate for extraction sizing
- When the session exceeds the budget, the `--priority` mode determines what gets cut
- With `--thorough`: the budget is ignored (extracts everything), unless you explicitly set `--max-tokens` to cap extraction even in thorough mode
- Lower budgets (e.g. `50000`) = faster, cheaper, but may miss content
- Higher budgets require models with larger context windows

### Thorough Mode (`--thorough`)

For sessions too large to fit in a single LLM context window. Two-phase process:

1. **Phase 1 (Chunking):** Extracts ALL messages (ignores token budget). Splits content into chunks sized to fit the model's context window:
   - `chunkSize = contextWindow - systemOverhead(2K) - outputReserve(20%) - safetyMargin(5%)`
   - Example: Claude Sonnet (200K context) -> ~146K chunks, GPT-4o (128K) -> ~89K chunks
   - Each chunk is summarized by the LLM independently

2. **Phase 2 (Synthesis):** All chunk summaries are combined and passed through the selected template for a final synthesis pass, producing the structured output.

**When to use:**
- Session has thousands of messages
- Getting truncation warnings with missing content
- Need comprehensive coverage over speed
- Results/conclusions appear mid-session (not just at the end)

**Trade-offs:** Slower (multiple LLM calls), more expensive (tokens for each chunk + synthesis), but much more complete.

### Output Destinations

| Option | Behavior |
|--------|----------|
| (none) | Print to terminal (streamed in real-time on TTY) |
| `-o, --output <path>` | Write to file. Creates parent directories if needed. Can combine with other targets. |
| `--clipboard` | Copy output to clipboard silently |
| `--apple-notes` | Save to Apple Notes (interactive folder picker pops up) |
| `--memory-dir <path>` | Only with `--mode memorization`: splits output by `## [topic]` headers into separate `{topic}.md` files in the given directory |

All targets can be combined: `-o summary.md --clipboard` writes to file AND copies to clipboard.

### LLM Selection

| Option | Description |
|--------|-------------|
| `--provider <name>` | LLM provider: `anthropic`, `openai`, `openrouter`, `google`, etc. |
| `--model <name>` | Model ID: `claude-sonnet-4-20250514`, `gpt-4o`, `gemini-2.0-flash`, etc. |
| `--prompt-only` | Output the prepared prompt without calling any LLM. With `--thorough`, shows chunk structure with token counts per chunk. Useful for debugging, cost estimation, or piping to another tool. |

### Prompt-Only Mode (`--prompt-only`)

Outputs the fully constructed prompt (system + user) without making any LLM call. Useful for:
- **Debugging:** See exactly what the LLM would receive
- **Cost estimation:** Check token counts before committing to an expensive call
- **Piping:** Send the prompt to a different tool or model
- **With `--thorough`:** Shows chunk breakdown: how many chunks, tokens per chunk, model-derived chunk sizes

## Example Invocations

```bash
# Quick summary of current session
tools claude history summarize --current --mode short-memory

# Full documentation of a specific session
tools claude history summarize abc123 --mode documentation -o docs/session-summary.md

# Extract learnings with benchmarks table
tools claude history summarize --current --mode learnings --clipboard

# Debug postmortem after a long debugging session
tools claude history summarize abc123 --mode debug-postmortem -o postmortem.md

# Build knowledge base from recent sessions
tools claude history summarize --since "7 days ago" --mode memorization --memory-dir ./memory/

# Large session — process everything
tools claude history summarize abc123 --mode documentation --thorough

# Custom extraction
tools claude history summarize abc123 --mode custom --custom-prompt "List all API endpoints discussed with their HTTP methods"

# Preview what would be sent to the LLM
tools claude history summarize abc123 --prompt-only --thorough --model claude-sonnet-4-20250514

# Interactive guided flow
tools claude history summarize -i
```
