# Claude History: Summarize & Memorize — Design Document

## Problem

The `tools claude-history` tool finds sessions effectively but extracting value from them (documentation, learnings, changelogs) requires a manual multi-step process: crafting search queries, spawning agents with handwritten prompts, and assembling output. This makes session knowledge extraction a rare, effortful activity instead of a routine one.

## Solution

A `summarize` subcommand that automates the full pipeline: session selection, content extraction, LLM-powered summarization, and structured output — with 7 preset modes, interactive prompts, and smart token management.

---

## Architecture

```
┌──────────────────────────────────┐
│  CLI Command (commands/summarize.ts)  │  ← Interactive (clack) + CLI flags
├──────────────────────────────────┤
│  SummarizeEngine (engine.ts)          │  ← Orchestration pipeline
├──────────┬───────────┬───────────┤
│ ClaudeSession  │ Templates │ LLM Caller │
│ (utils/claude/ │ (7 modes) │ (ask tool) │
│  session.ts)   │           │            │
└──────────┴───────────┴───────────┘
```

### Layer 1: `ClaudeSession` — Reusable Session Parser

**File:** `src/utils/claude/session.ts`

A fully-typed class wrapping a session JSONL file. Designed for reuse beyond summarization.

**Core API:**
- `static fromFile(path)` / `static fromSessionId(id, projectDir?)` — constructors
- `static findSessions(options)` — discovery with date/project/subagent filters
- Message accessors: `.userMessages`, `.assistantMessages`, `.toolCalls`, etc.
- Filtering: `.filterByTool()`, `.filterByDateRange()`, `.filterByContent()`
- Extraction: `.extractText(options)`, `.extractFilePaths()`, `.extractCommitHashes()`
- Stats: `.stats` — counts, token usage, model distribution, files modified
- LLM prep: `.toPromptContent(options)` — smart truncation to fit token budget

**Content priority for `toPromptContent()`:**
1. User messages (highest priority — these are the intent)
2. Assistant text responses (the actual work)
3. Tool call summaries (name + file path, no results)
4. Thinking blocks (if requested)
5. Tool results (if requested, heavily truncated)

**Types:** Moved to `src/utils/claude/types.ts` for shared access. `src/claude-history/types.ts` re-exports for backward compatibility.

### Layer 2: Prompt Templates — 7 Modes

**Directory:** `src/claude-history/summarize/templates/`

Each mode is a class implementing `PromptTemplate`:

| Mode | Class | Purpose |
|------|-------|---------|
| `documentation` | `DocumentationTemplate` | Full structured tech doc: Problem, Changes, Patterns, Lessons, Files |
| `memorization` | `MemorizationTemplate` | Comprehensive learnings: architecture decisions, patterns, gotchas, debugging techniques |
| `short-memory` | `ShortMemoryTemplate` | Concise MEMORY.md-ready bullets (500-2000 chars) |
| `changelog` | `ChangelogTemplate` | What changed — added/changed/fixed/removed with file paths |
| `debug-postmortem` | `DebugPostmortemTemplate` | Symptoms, Investigation Timeline, Dead Ends, Root Cause, Fix, Prevention |
| `onboarding` | `OnboardingTemplate` | "How this works" for new devs: Overview, Architecture, Key Files, Data Flow |
| `custom` | `CustomTemplate` | User provides their own prompt, minimal system prompt |

**Interface:**
```typescript
interface PromptTemplate {
  name: string
  description: string
  systemPrompt: string
  buildUserPrompt(context: TemplateContext): string
  outputInstructions: string
}
```

### Layer 3: SummarizeEngine — Orchestration

**File:** `src/claude-history/summarize/engine.ts`

Pipeline: `Extract → Budget → Prompt → LLM → Format`

1. **Extract**: `ClaudeSession.toPromptContent()` with configured options
2. **Budget**: Check token count against model's context window. If over: smart truncation (default) or chunked summarization (`--thorough`)
3. **Prompt**: Template's `buildUserPrompt()` with session context
4. **LLM**: Call via ask tool's `ChatEngine` (streaming by default in TTY)
5. **Format**: Structure output based on mode (markdown doc, memory entries, topic files)

**Chunked summarization** (`--thorough`):
1. Split content into N chunks fitting the token budget
2. Summarize each chunk with a "summarize this portion" prompt
3. Synthesis pass: combine chunk summaries with the full template prompt
4. More expensive (2-3x LLM cost) but captures everything

**Prompt-only mode** (`--prompt-only`):
- Skip LLM call entirely
- Output the prepared prompt (system + user) to stdout/file/clipboard
- Useful for using with external AI tools or for review

### Layer 4: CLI Command

**File:** `src/claude-history/commands/summarize.ts`

**Entry points:**
1. `tools claude-history summarize [session-id] [options]` — direct subcommand
2. After search results (interactive mode) → "Summarize this session?" prompt

**CLI flags:**
```
--session <id>           Session ID(s), repeatable (-s shorthand)
--current                Use $CLAUDE_CODE_SESSION_ID env var
--since/--until <date>   Date range for discovery
--mode <name>            Template mode (default: documentation)
--model <name>           LLM model
--provider <name>        LLM provider
--prompt-only            Output prompt without LLM call
--output/-o <path>       Write to file
--clipboard              Copy to clipboard
--thorough               Chunked summarization
--max-tokens <n>         Token budget (default: 128000)
--include-tool-results   Include tool results in extraction
--include-thinking       Include thinking blocks
--priority <type>        balanced | user-first | assistant-first
--interactive/-i         Interactive guided flow
--custom-prompt <text>   Custom prompt text
--memory-dir <path>      Output dir for memorization topic files
```

**Interactive flow (clack):**
1. Session picker → searchable select from `findSessions()`
2. Mode picker → select from `listTemplates()`
3. Provider/model → if multiple available
4. Custom prompt → if custom mode
5. Preview → token count + estimated cost
6. Confirm → run

**Non-TTY:** All via flags, sensible defaults, clear error messages for missing required options.

**Session ID resolution (priority order):**
1. Positional arg or `--session` flag
2. `--current` → `$CLAUDE_CODE_SESSION_ID`
3. `--since/--until` → date range discovery
4. Interactive → prompt user
5. Non-interactive without session → error with help text

---

## Token Management

### Smart Truncation (default)
- `toPromptContent()` with token budget
- Priority-based: user messages first, then assistant text, then tool summaries
- Always includes first + last messages (session bookends)
- Shows warning: "Session truncated: included 45/120 messages (85k/200k tokens)"

### Chunked Summarization (`--thorough`)
- Split into chunks of `chunkSize` tokens (default: 100k)
- Per-chunk summary → final synthesis
- Warn about estimated cost before running (interactive: confirm prompt)

### Budget Calculation
- Reserve 20% of model context for output + system prompt
- Content budget = `min(--max-tokens, model_context * 0.8) - system_prompt_tokens`
- Use `estimateTokens()` from `src/utils/tokens.ts` for fast estimation

---

## Output Handling

### By Mode

| Mode | Default Output | Memory Files |
|------|---------------|-------------|
| documentation | `stdout` or `--output` file | No |
| memorization | `stdout` + topic files in `--memory-dir` | Yes: `memory/<topic>.md` files |
| short-memory | `stdout` or `--output` file | No (designed to paste into MEMORY.md) |
| changelog | `stdout` or `--output` file | No |
| debug-postmortem | `stdout` or `--output` file | No |
| onboarding | `stdout` or `--output` file | No |
| custom | `stdout` or `--output` file | No |

### Memorization Topic Files
The LLM is instructed to tag each learning with a topic. The engine groups learnings by topic and writes separate files:
- `memory/architecture.md` — architectural decisions
- `memory/debugging.md` — debugging patterns
- `memory/patterns.md` — code patterns
- etc.

Each file is append-safe (new entries are added, existing ones preserved).

---

## Dependencies on Ask Tool

| Component | Import From | Purpose |
|-----------|-------------|---------|
| `ProviderManager` | `src/ask/providers/ProviderManager.ts` | Detect available LLM providers |
| `ModelSelector` | `src/ask/providers/ModelSelector.ts` | Interactive model picker |
| `ChatEngine` | `src/ask/chat/ChatEngine.ts` | Send prompt to LLM (streaming + non-streaming) |
| `DynamicPricingManager` | `src/ask/providers/DynamicPricing.ts` | Cost estimation |
| `getLanguageModel` | `src/ask/types/provider.ts` | Create language model instance |
| `estimateTokens` | `src/utils/tokens.ts` | Fast token count estimation |

---

## Existing Code Reuse

| What | Where | How |
|------|-------|-----|
| JSONL parsing | `src/utils/claude/index.ts:25-49` | `parseJsonlTranscript()` |
| Session file discovery | `src/claude-history/lib.ts:84-136` | Glob patterns for .jsonl files |
| Text extraction patterns | `src/claude-history/lib.ts:240-304` | Adapt `extractTextFromMessage()` |
| Metadata extraction | `src/claude-history/lib.ts:1188-1291` | Pattern for `extractSessionMetadataFromFile()` |
| Session listing | `src/claude-history/lib.ts:1043-1126` | `getSessionListing()` for session discovery |
| Encoded project dir | `src/utils/claude/index.ts:96-100` | `encodedProjectDir()` |
| Format helpers | `src/utils/format.ts` | Duration, bytes, token formatting |
| Commander pattern | `src/claude-history/index.ts:199-322` | Existing command registration |
