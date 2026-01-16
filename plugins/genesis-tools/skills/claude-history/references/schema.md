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
