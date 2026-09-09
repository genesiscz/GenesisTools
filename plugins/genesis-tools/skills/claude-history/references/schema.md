# Claude Code Conversation History Schema

Reference for the JSONL conversation history file structure.

## File Locations

- **Project conversations**: `~/.claude/projects/<encoded-path>/*.jsonl`
- **Global history**: `~/.claude/history.jsonl`
- **Subagent conversations**: `~/.claude/projects/**/subagents/agent-*.jsonl`

## Message Types

```typescript
type MessageType =
  | "user"                 // User input and tool results
  | "assistant"            // Claude responses
  | "system"               // System events (errors, hooks)
  | "summary"              // Auto-generated summaries
  | "custom-title"         // User-defined titles
  | "file-history-snapshot" // File backup snapshots
  | "queue-operation"      // Message queue events
  | "subagent"             // Messages from spawned subagents
```

## Key Fields by Type

### User Messages
- `.message.content` - String or array of content blocks
- `.timestamp` - ISO 8601 timestamp
- `.gitBranch` - Git branch context

### Assistant Messages
- `.message.content[]` - Array of content blocks
- `.message.model` - Model used (e.g., "claude-opus-4-5-20251101")
- `.message.content[].type` - "text", "thinking", or "tool_use"
- `.message.content[].name` - Tool name (for tool_use)
- `.message.content[].input.file_path` - File path (for Edit/Write/Read)

### Summary Messages
- `.summary` - Auto-generated conversation summary
- `.leafUuid` - Reference to conversation endpoint

### Custom Title Messages
- `.customTitle` - User-defined session title
- `.sessionId` - Session identifier

## Tool Names

Common tools: Bash, Edit, Write, Read, Grep, Glob, TodoWrite, Task, TaskOutput, Skill, LSP, AskUserQuestion, ExitPlanMode, EnterPlanMode, WebFetch, WebSearch

MCP tools follow pattern: `mcp__<server>__<tool>`

## Example jq Queries

```bash
# Get all message types
cat file.jsonl | jq -c '.type' | sort | uniq -c

# Find files modified by Edit tool
cat file.jsonl | jq -c 'select(.type=="assistant") | .message.content[] | select(.type=="tool_use" and .name=="Edit") | .input.file_path'

# Get conversation summaries
cat file.jsonl | jq -c 'select(.type=="summary") | .summary'

# Get user messages
cat file.jsonl | jq 'select(.type=="user") | .message.content' | head
```

## Shared provider history database

Provider history commands use `~/.genesis-tools/claude-history/index.db`. Its existing Claude metadata/statistics schema is generalized through provider readers and shared repositories. Normal searches synchronize metadata automatically; status performs read-only inspection. Explicit metadata sync/rebuild never rewrites native sources or credentials.

| Table | Ownership and contents |
| --- | --- |
| `session_metadata` | One bounded row per `source_key`: provider, native ID/home, physical locator, titles/prompts, dates, subagent/archive state and bounded-field markers. No transcript body mirror. |
| `file_index` | Source freshness, metadata/statistics parser revisions, independent telemetry revision and known counts/coverage. |
| `history_roots` | Discovery generations and completed traversals; failed or filtered traversals cannot prove deletion. |
| `history_source_issues` | Bounded current source diagnostics, without transcript text. |
| `file_daily_stats` | Replaceable per-source/day/project aggregate contributions. |
| `daily_stats` | Provider/day/project rollups; `__all__` is scoped within each provider. |
| `totals_cache` | Provider/scope totals with explicit coverage; incomplete backfills preserve prior published numbers. |
| `usage_snapshots`, `spend_snapshots` | Historical account observations owned by usage polling. They are not disposable history cache rows. |
| `_migrations` | Migration records retain their owning subsystem scopes. |

Message bodies, normalized-message copies, and full-text mirrors are not stored in this schema. Search and context hydrate native records by opaque provider locators. Metadata refresh and full statistics refresh are separate operations; missing metrics remain unavailable rather than becoming fabricated zeros. History maintenance must not delete the whole database.

- Claude: project JSONL, custom titles/summaries and sessions-index metadata. Original records support compatible rendering.
- Codex: active/archived rollouts, state/session-index metadata and readable paginated projections. `session_meta.payload.id` identifies a native thread; a subagent can share its parent's `session_id`, so prefer `id`.
- Grok: summaries and chat history, including known isolated worker roots. `updates.jsonl` is separate usage telemetry; statistics track its revision without adding it to conversation search.

Identity is `(provider, native ID, canonical source home)`. Preserve source home/key/file/cwd through selection; do not collapse different homes or infer ownership from today's login. Unsupported fields are reported rather than fabricated. Cross-home copies and credential imports require separate authorization; search needs neither.
