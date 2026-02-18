# Claude History: Summarize & Memorize Feature

## Context

The `tools claude-history` tool currently searches and displays session history but has no built-in way to **summarize** or **extract learnings** from sessions. The manual process (documented in `docs/claude-history/summarize.md`) works but requires crafting search queries, spawning agents, and writing prompts each time. This feature automates that entire pipeline as a first-class `summarize` subcommand — with multiple output modes, interactive prompts, direct LLM integration, and smart token management.

## Architecture: Engine + Pipeline (Approach B)

Three layers:

```
src/utils/claude/types.ts          ← Shared JSONL message types (moved from claude-history)
src/utils/claude/session.ts        ← ClaudeSession class (new, reusable)
src/claude-history/summarize/      ← Summarization engine + templates + CLI
```

---

## Implementation Steps

### Step 1: Move types to shared location

**Files:**
- Create `src/utils/claude/types.ts` — move all JSONL message types from `src/claude-history/types.ts`
- Update `src/claude-history/types.ts` — re-export from `src/utils/claude/types.ts` for backward compat
- Update `src/utils/claude/index.ts` — export from new types file

**What moves:**
- All message type interfaces: `BaseMessage`, `UserMessage`, `AssistantMessage`, `SystemMessage`, `SummaryMessage`, `CustomTitleMessage`, `FileHistorySnapshot`, `QueueOperation`, `SubagentMessage`
- Content block types: `TextBlock`, `ThinkingBlock`, `ToolUseBlock`, `ToolResultBlock`, `ContentBlock`
- `MessageType`, `UserType`, `Usage`, `ConversationMessage` union
- `KNOWN_TOOLS` constant

**What stays in `src/claude-history/types.ts`:**
- `SearchResult`, `SearchFilters`, `SessionListItem`, `ConversationStats` — search-specific types
- Re-exports of moved types for existing import compatibility

### Step 2: Create `ClaudeSession` class

**File:** `src/utils/claude/session.ts`

```typescript
class ClaudeSession {
  // Construction
  static async fromFile(filePath: string): Promise<ClaudeSession>
  static async fromSessionId(sessionId: string, projectDir?: string): Promise<ClaudeSession>
  static async findSessions(options: SessionDiscoveryOptions): Promise<SessionInfo[]>

  // Metadata (extracted on load, cached)
  get sessionId(): string | null
  get title(): string | null           // custom-title or summary
  get summary(): string | null
  get gitBranch(): string | null
  get cwd(): string | null
  get project(): string | null
  get startDate(): Date | null
  get endDate(): Date | null
  get duration(): number               // milliseconds
  get isSubagent(): boolean

  // Message access
  get messages(): ConversationMessage[]
  get userMessages(): UserMessage[]
  get assistantMessages(): AssistantMessage[]
  get systemMessages(): SystemMessage[]

  // Content extraction
  extractText(options?: ExtractTextOptions): string
  extractToolCalls(): ToolCallSummary[]
  extractFilePaths(): string[]
  extractCommitHashes(): string[]
  extractThinkingBlocks(): string[]

  // Filtering (returns new ClaudeSession with filtered messages)
  filterByTool(toolName: string): ClaudeSession
  filterByDateRange(since?: Date, until?: Date): ClaudeSession
  filterByContent(query: string): ClaudeSession
  filterByMessageType(...types: MessageType[]): ClaudeSession

  // Stats
  get stats(): SessionStats

  // LLM preparation
  toPromptContent(options: PromptContentOptions): PreparedContent
}

interface ExtractTextOptions {
  includeToolResults?: boolean    // default: false
  includeThinking?: boolean       // default: false
  includeSystemMessages?: boolean // default: false
  includeToolNames?: boolean      // default: true
  maxLength?: number              // char limit
}

interface PromptContentOptions {
  tokenBudget: number             // max tokens for content
  priority: 'balanced' | 'user-first' | 'assistant-first'
  includeToolResults?: boolean
  includeThinking?: boolean
  includeTimestamps?: boolean
}

interface PreparedContent {
  content: string
  tokenCount: number
  truncated: boolean
  truncationInfo: string          // "Included 45/120 messages, 85k/200k tokens"
  stats: {
    userMessages: number
    assistantMessages: number
    toolCalls: number
    filesModified: string[]
  }
}

interface SessionStats {
  messageCount: number
  userMessageCount: number
  assistantMessageCount: number
  toolCallCount: number
  toolUsage: Record<string, number>   // tool name → count
  tokenUsage: { input: number; output: number; cached: number }
  modelsUsed: string[]
  filesModified: string[]
  duration: number
  firstTimestamp: Date | null
  lastTimestamp: Date | null
}

interface SessionInfo {
  filePath: string
  sessionId: string | null
  title: string | null
  summary: string | null
  gitBranch: string | null
  project: string | null
  startDate: Date | null
  fileSize: number
  messageCount: number
  isSubagent: boolean
}

interface SessionDiscoveryOptions {
  project?: string
  since?: Date
  until?: Date
  includeSubagents?: boolean
  limit?: number
}
```

**Key implementation notes:**
- Uses `parseJsonlTranscript()` from `src/utils/claude/index.ts` for JSONL parsing
- `toPromptContent()` is the main method for LLM preparation:
  1. Iterate messages in order
  2. For each message, extract text content based on priority
  3. Track running token count using `estimateTokens()` from `src/utils/tokens.ts`
  4. When budget reached, stop and record truncation info
  5. Format as readable conversation transcript (e.g., `[User]: ...`, `[Assistant]: ...`, `[Tool: Edit] file.ts`)
- `findSessions()` reuses glob patterns from `src/claude-history/lib.ts:84-136`
- `fromSessionId()` does a prefix match against filenames in the project dir

### Step 3: Create prompt template system

**Files:**
- `src/claude-history/summarize/templates/index.ts` — interface + factory
- `src/claude-history/summarize/templates/documentation.ts`
- `src/claude-history/summarize/templates/memorization.ts`
- `src/claude-history/summarize/templates/short-memory.ts`
- `src/claude-history/summarize/templates/changelog.ts`
- `src/claude-history/summarize/templates/debug-postmortem.ts`
- `src/claude-history/summarize/templates/onboarding.ts`
- `src/claude-history/summarize/templates/custom.ts`

**Interface:**
```typescript
interface PromptTemplate {
  name: string
  description: string
  systemPrompt: string
  buildUserPrompt(context: TemplateContext): string
  outputInstructions: string
}

interface TemplateContext {
  sessionContent: string
  sessionId: string
  sessionDate: string
  gitBranch?: string
  projectName?: string
  sessionTitle?: string
  customInstructions?: string
  tokenCount: number
  truncated: boolean
  truncationInfo?: string
}

function getTemplate(mode: string): PromptTemplate
function listTemplates(): Array<{ name: string; description: string }>
```

Each template is a class implementing `PromptTemplate`. Template prompt specs:

**DocumentationTemplate** — System: "You are a technical documentation writer analyzing a Claude Code session." Sections: Problem Statement, Root Cause Analysis (if applicable), Changes Made (by file with code snippets), Key Code Patterns, Lessons Learned, Related Files. Thorough, capture everything needed to understand the work months later.

**MemorizationTemplate** — System: "You are a knowledge extraction specialist." Output: comprehensive analysis organized by topic tags (`[architecture]`, `[debugging]`, `[pattern]`, `[gotcha]`, `[config]`). Each learning must be self-contained with context. Include rationale for decisions, not just what was done. Tag each entry so the engine can split into topic files.

**ShortMemoryTemplate** — System: "You are a concise knowledge distiller." Output: markdown bullet points, 500-2000 chars total. Only the most critical, reusable knowledge. Format ready to paste into MEMORY.md.

**ChangelogTemplate** — System: "You are a changelog writer." Output: Added/Changed/Fixed/Removed sections with file paths and brief descriptions. Include the "why" for each change. Git-log style but with human context.

**DebugPostmortemTemplate** — System: "You are a debugging analyst." Sections: Symptoms Observed, Investigation Timeline (chronological), Dead Ends (what didn't work and why), Root Cause, The Fix, Prevention. Focus on the debugging PROCESS.

**OnboardingTemplate** — System: "You are writing onboarding documentation." Sections: Overview, Architecture, Key Files and Roles, Data Flow, Common Operations, Gotchas. Written for someone who has never seen the code.

**CustomTemplate** — System: "You are analyzing a Claude Code conversation session." Minimal wrapper around user's custom prompt + session content.

**Implementation note**: Use the `prompt-engineer` agent during implementation to craft the full prompt text for each template class. The specs above define the structure and intent.

### Step 4: Create `SummarizeEngine`

**File:** `src/claude-history/summarize/engine.ts`

```typescript
class SummarizeEngine {
  constructor(options: SummarizeOptions)

  async run(): Promise<SummarizeResult>

  // Pipeline steps (public for testing/composition)
  async extractContent(): Promise<PreparedContent>
  async buildPrompt(): Promise<{ system: string; user: string; tokenCount: number }>
  async callLLM(prompt: { system: string; user: string }): Promise<string>
  formatOutput(llmResponse: string): SummarizeOutput
}

interface SummarizeOptions {
  session: ClaudeSession
  mode: string                      // template name
  customPrompt?: string             // for 'custom' mode

  // LLM config
  provider?: string
  model?: string
  streaming?: boolean               // default: true (TTY), false (non-TTY)
  promptOnly?: boolean              // default: false

  // Content config
  tokenBudget?: number              // default: 128000
  includeToolResults?: boolean
  includeThinking?: boolean
  priority?: 'balanced' | 'user-first' | 'assistant-first'

  // Chunking
  thorough?: boolean                // chunked summarization
  chunkSize?: number                // tokens per chunk (default: 100000)

  // Output
  outputPath?: string
  clipboard?: boolean
  memoryDir?: string                // for memorization mode
}

interface SummarizeResult {
  content: string
  mode: string
  tokenUsage: { input: number; output: number }
  cost: number
  truncated: boolean
  truncationInfo?: string
  outputPaths: string[]             // files written
}

interface SummarizeOutput {
  markdown: string
  memoryEntries?: string            // for memorization/short-memory modes
  topicFiles?: Array<{ path: string; content: string }>  // for memorization mode
}
```

**LLM integration:**
- Import `ProviderManager` from `src/ask/providers/ProviderManager.ts`
- Import `ChatEngine` from `src/ask/chat/ChatEngine.ts`
- Import `DynamicPricingManager` from `src/ask/providers/DynamicPricing.ts`
- Import `ModelSelector` from `src/ask/providers/ModelSelector.ts`
- Create a `LanguageModel` via `getLanguageModel()` from `src/ask/types/provider.ts`
- Call `ChatEngine.sendStreamingMessage()` or `sendNonStreamingMessage()`

**Chunked summarization** (`--thorough`):
1. Split session content into N chunks of `chunkSize` tokens
2. For each chunk: send to LLM with "Summarize this portion of the session" prompt
3. Collect all chunk summaries
4. Final synthesis: send all chunk summaries to LLM with the original template prompt
5. Return the synthesis result

**Prompt-only mode** (`--prompt-only`):
- Skip LLM call
- Output the full prompt (system + user) to stdout/file/clipboard
- Include token count info as a comment at top

### Step 5: Create CLI command

**File:** `src/claude-history/commands/summarize.ts`

```typescript
export function registerSummarizeCommand(program: Command): void
```

**Commander options:**
```
summarize [session-id]              Summarize a session
  -s, --session <id>                Session ID (repeatable)
  --current                         Current session (from $CLAUDE_CODE_SESSION_ID)
  --since <date>                    Sessions since date
  --until <date>                    Sessions until date
  -m, --mode <name>                 Template mode (default: documentation)
  --model <name>                    LLM model name
  --provider <name>                 LLM provider
  --prompt-only                     Output prompt without calling LLM
  -o, --output <path>               Write to file
  --clipboard                       Copy to clipboard
  --thorough                        Chunked summarization for large sessions
  --max-tokens <n>                  Token budget (default: 128000)
  --include-tool-results            Include tool execution results
  --include-thinking                Include thinking blocks
  --priority <type>                 Content priority: balanced|user-first|assistant-first
  -i, --interactive                 Guided interactive flow
  --custom-prompt <text>            Custom summarization prompt
  --memory-dir <path>               Output dir for memorization topic files
```

**Interactive flow** (clack prompts):
1. **Session selection**: `select` with searchable list from `ClaudeSession.findSessions()`. Shows title + date + branch. Supports multi-select for batch.
2. **Mode selection**: `select` from `listTemplates()` — shows name + description.
3. **Model/provider** (if multiple available): `select` provider, then `select` model.
4. **Custom prompt** (if custom mode): `text` input.
5. **Token preview**: Show session size + estimated tokens + cost estimate.
6. **Confirm**: `confirm` before LLM call.

**Non-TTY flow**: All options via CLI flags. If required options missing, error with clear message. Sensible defaults: documentation mode, first available provider, stdout output.

**Session ID resolution** (in order):
1. Positional arg or `--session` flag
2. `--current` flag → `$CLAUDE_CODE_SESSION_ID` env var
3. `--since/--until` → date range discovery
4. Interactive → prompt user to pick from list
5. Non-interactive without session → error "Please specify --session <id> or --current"

### Step 6: Register subcommand + integrate with search

**File:** `src/claude-history/index.ts`

Changes:
1. Import and register `registerSummarizeCommand(program)` alongside the existing `dashboard` subcommand
2. After search results display (line ~136), if interactive (`-i` flag) and TTY: offer "Summarize this session?" action via clack `confirm`. If yes, launch summarize flow with the matched session.

### Step 7: Update skill file

**File:** `plugins/genesis-tools/skills/claude-history/SKILL.md`

Add documentation for the new `summarize` subcommand with examples.

---

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `src/utils/claude/types.ts` | **Create** | Shared JSONL message types |
| `src/utils/claude/session.ts` | **Create** | ClaudeSession class |
| `src/utils/claude/index.ts` | **Modify** | Add exports for types + session |
| `src/claude-history/types.ts` | **Modify** | Re-export from shared types |
| `src/claude-history/summarize/engine.ts` | **Create** | SummarizeEngine |
| `src/claude-history/summarize/templates/index.ts` | **Create** | Template interface + factory |
| `src/claude-history/summarize/templates/documentation.ts` | **Create** | Documentation template |
| `src/claude-history/summarize/templates/memorization.ts` | **Create** | Memorization template |
| `src/claude-history/summarize/templates/short-memory.ts` | **Create** | Short memory template |
| `src/claude-history/summarize/templates/changelog.ts` | **Create** | Changelog template |
| `src/claude-history/summarize/templates/debug-postmortem.ts` | **Create** | Debug postmortem template |
| `src/claude-history/summarize/templates/onboarding.ts` | **Create** | Onboarding template |
| `src/claude-history/summarize/templates/custom.ts` | **Create** | Custom prompt template |
| `src/claude-history/commands/summarize.ts` | **Create** | CLI command + interactive flow |
| `src/claude-history/index.ts` | **Modify** | Register summarize subcommand + post-search integration |
| `plugins/genesis-tools/skills/claude-history/SKILL.md` | **Modify** | Add summarize documentation |

## Existing Code to Reuse

| Component | Location | Usage |
|-----------|----------|-------|
| JSONL parser | `src/utils/claude/index.ts:25-49` | `parseJsonlTranscript()` for session loading |
| Token estimation | `src/utils/tokens.ts:1-65` | `estimateTokens()`, `countTokens()`, `limitToTokens()` |
| ProviderManager | `src/ask/providers/ProviderManager.ts` | Provider detection, model fetching |
| ChatEngine | `src/ask/chat/ChatEngine.ts` | LLM call with streaming |
| ModelSelector | `src/ask/providers/ModelSelector.ts` | Interactive model selection |
| DynamicPricing | `src/ask/providers/DynamicPricing.ts` | Cost calculation |
| Session discovery | `src/claude-history/lib.ts:84-136` | Glob patterns for finding .jsonl files |
| Metadata extraction | `src/claude-history/lib.ts:1188-1291` | Pattern for extracting session metadata |
| Text extraction | `src/claude-history/lib.ts:240-276` | `extractTextFromMessage()` pattern |
| Format utilities | `src/utils/format.ts` | Bytes, duration, tokens formatting |
| Claude utils | `src/utils/claude/index.ts` | `encodedProjectDir()`, `getClaudeProjectsDir()` |

## Verification

1. **Unit test the ClaudeSession class:**
   ```bash
   # Load a known session and verify metadata
   tools claude-history --list-summaries -l 1
   # Then in code: ClaudeSession.fromSessionId("<id>")
   ```

2. **Test summarize command (interactive):**
   ```bash
   tools claude-history summarize -i
   ```

3. **Test summarize command (non-interactive):**
   ```bash
   tools claude-history summarize <session-id> --mode documentation --provider anthropic
   ```

4. **Test prompt-only mode:**
   ```bash
   tools claude-history summarize <session-id> --mode short-memory --prompt-only
   ```

5. **Test chunked summarization:**
   ```bash
   tools claude-history summarize <session-id> --mode documentation --thorough
   ```

6. **Test memorization output:**
   ```bash
   tools claude-history summarize <session-id> --mode memorization --output ./session-learnings.md
   ```

7. **Test post-search integration:**
   ```bash
   tools claude-history "some query" -i
   # After results, should offer "Summarize this session?"
   ```

8. **Test token budget warning:**
   ```bash
   # Use a large session with small budget
   tools claude-history summarize <large-session-id> --max-tokens 10000
   ```

9. **Verify type compilation:**
   ```bash
   bunx tsgo --noEmit
   ```
