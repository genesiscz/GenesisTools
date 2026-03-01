# Subagent Inspect — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `history agent <agentId>` subcommand that produces a rich, structured overview of a subagent — its spawn context, model, tool flow, and final output — similar to a manual forensic trace but automated.

**Architecture:** New subcommand `history agent <agentId>` that: (1) finds the subagent JSONL by globbing for `agent-*<id>*.jsonl`, (2) parses it for metadata + tool flow, (3) cross-references the parent session to extract the Task tool call (subagent_type, description, prompt), (4) renders a structured markdown report. All logic lives in a new `src/claude/lib/history/agent-inspect.ts` module. The command is registered as a subcommand of `history` in `history.ts`.

**Tech Stack:** TypeScript, Bun, Commander.js, existing JSONL parser from `search.ts`

---

### Task 1: Create the agent-inspect module types and finder

**Files:**
- Create: `src/claude/lib/history/agent-inspect.ts`

**Step 1: Create the module with types and agent file finder**

```typescript
// In agent-inspect.ts

import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { glob } from "glob";
import { PROJECTS_DIR, extractProjectName, parseJsonlFile } from "./search";
import type { AssistantMessage, ConversationMessage, ToolUseBlock, UserMessage } from "./types";

// --- Types ---

export interface AgentSpawnContext {
    subagentType: string;
    description: string;
    prompt: string;
    name?: string;
    mode?: string;
    model?: string;
    isolation?: string;
}

export interface ToolStep {
    index: number;
    tool: string;
    summary: string;       // e.g. "Read src/daemon/lib/types.ts" or "Bash: git status"
    filePath?: string;      // extracted file_path/path if present
}

export interface AgentInspectResult {
    agentId: string;
    slug?: string;
    model?: string;
    parentSessionId: string;
    parentSessionFile: string;
    agentFile: string;
    project: string;
    gitBranch?: string;
    timestamp?: string;
    spawnContext?: AgentSpawnContext;
    toolFlow: ToolStep[];
    firstUserMessage: string;
    finalAssistantText?: string;
    messageStats: {
        userMessages: number;
        assistantMessages: number;
        toolCalls: number;
    };
}

/**
 * Find the subagent JSONL file by partial agentId match.
 * Searches ~/.claude/projects/ for files matching agent-*<id>*.jsonl
 */
export async function findAgentFile(agentId: string): Promise<string | null> {
    const patterns = [
        `${PROJECTS_DIR}/**/subagents/agent-*${agentId}*.jsonl`,
        `${PROJECTS_DIR}/**/agent-*${agentId}*.jsonl`,
    ];

    for (const pattern of patterns) {
        const matches = await glob(pattern, { absolute: true });
        if (matches.length > 0) {
            return matches[0];
        }
    }

    return null;
}
```

**Step 2: Verify the file compiles**

Run: `cat src/claude/lib/history/agent-inspect.ts | bunx tsgo --noEmit`
Expected: No errors (or check with full project build)

---

### Task 2: Add parent session cross-referencing

**Files:**
- Modify: `src/claude/lib/history/agent-inspect.ts`

**Step 1: Add function to find and parse the parent session's Task call**

The parent session file is the main JSONL in the same session directory (the directory that contains `subagents/`). We need to search its content for a `Task` tool_use block whose spawned agentId matches (or whose prompt/description matches the subagent's first user message).

```typescript
/**
 * Derive the parent session file from the subagent file path.
 * Subagent files live at: <sessionDir>/subagents/agent-<id>.jsonl
 * Parent file lives at: <sessionDir>.jsonl (one level up from subagents/)
 */
function findParentSessionFile(agentFilePath: string): string | null {
    const subagentsDir = dirname(agentFilePath);
    const sessionDir = dirname(subagentsDir);
    const sessionDirName = basename(sessionDir);

    // Parent JSONL is at the same level: <projectDir>/<sessionId>.jsonl
    const parentFile = resolve(dirname(sessionDir), `${sessionDirName}.jsonl`);

    if (existsSync(parentFile)) {
        return parentFile;
    }

    return null;
}

/**
 * Search the parent session for the Task tool_use block that spawned this agent.
 * Matches by comparing the Task prompt to the agent's first user message,
 * since the Task prompt becomes the agent's first user message verbatim.
 */
async function findSpawnContext(
    parentFile: string,
    firstUserMessage: string
): Promise<AgentSpawnContext | undefined> {
    const messages = await parseJsonlFile(parentFile);

    for (const msg of messages) {
        if (msg.type !== "assistant") {
            continue;
        }

        const assistantMsg = msg as AssistantMessage;
        const toolUses = assistantMsg.message.content.filter(
            (b): b is ToolUseBlock => b.type === "tool_use" && b.name === "Task"
        );

        for (const tool of toolUses) {
            const input = tool.input as Record<string, unknown>;
            const prompt = (input.prompt as string) || "";

            // Match: the Task prompt should match the agent's first user message
            if (prompt && firstUserMessage.startsWith(prompt.slice(0, 200))) {
                return {
                    subagentType: (input.subagent_type as string) || "unknown",
                    description: (input.description as string) || "",
                    prompt,
                    name: input.name as string | undefined,
                    mode: input.mode as string | undefined,
                    model: input.model as string | undefined,
                    isolation: input.isolation as string | undefined,
                };
            }
        }
    }

    return undefined;
}
```

**Step 2: Verify it compiles**

Run: `tsgo --noEmit | rg "agent-inspect"`
Expected: No errors

---

### Task 3: Add the main inspect function

**Files:**
- Modify: `src/claude/lib/history/agent-inspect.ts`

**Step 1: Add the core `inspectAgent()` function**

This orchestrates everything: finds the file, parses it, extracts tool flow, cross-references parent.

```typescript
/**
 * Extract a structured tool step from a ToolUseBlock
 */
function toolUseToStep(tool: ToolUseBlock, index: number): ToolStep {
    const input = tool.input as Record<string, unknown>;
    const filePath = (input.file_path || input.path) as string | undefined;
    const command = (input.command as string) || "";
    const pattern = (input.pattern as string) || "";
    const query = (input.query as string) || "";
    const skill = (input.skill as string) || "";

    let summary: string;

    switch (tool.name) {
        case "Read":
        case "Write":
        case "Edit":
            summary = filePath ? `${filePath}` : tool.name;
            break;
        case "Bash":
            summary = command.length > 120 ? `${command.slice(0, 120)}...` : command;
            break;
        case "Grep":
            summary = `pattern="${pattern}"${filePath ? ` path=${filePath}` : ""}`;
            break;
        case "Glob":
            summary = pattern;
            break;
        case "Skill":
            summary = skill;
            break;
        case "Task":
            summary = `subagent_type=${(input.subagent_type as string) || "?"}, desc=${((input.description as string) || "").slice(0, 80)}`;
            break;
        default:
            summary = filePath || command || pattern || JSON.stringify(input).slice(0, 100);
            break;
    }

    return { index, tool: tool.name, summary, filePath };
}

/**
 * Main entry point: inspect a subagent by its agentId.
 */
export async function inspectAgent(agentId: string): Promise<AgentInspectResult | null> {
    const agentFile = await findAgentFile(agentId);

    if (!agentFile) {
        return null;
    }

    const messages = await parseJsonlFile(agentFile);

    if (messages.length === 0) {
        return null;
    }

    // Extract metadata from first message
    const firstMsg = messages[0];
    const baseInfo = "sessionId" in firstMsg ? firstMsg : undefined;
    const sessionId = baseInfo?.sessionId || "unknown";
    const gitBranch = ("gitBranch" in firstMsg ? (firstMsg as { gitBranch?: string }).gitBranch : undefined);
    const agentIdFromMsg = ("agentId" in firstMsg ? (firstMsg as { agentId?: string }).agentId : undefined);
    const slug = ("slug" in firstMsg ? (firstMsg as { slug?: string }).slug : undefined);
    const timestamp = ("timestamp" in firstMsg ? (firstMsg as { timestamp?: string }).timestamp : undefined);

    // Extract first user message text
    let firstUserMessage = "";
    for (const msg of messages) {
        if (msg.type === "user") {
            const userMsg = msg as UserMessage;
            if (typeof userMsg.message.content === "string") {
                firstUserMessage = userMsg.message.content;
            } else if (Array.isArray(userMsg.message.content)) {
                firstUserMessage = userMsg.message.content
                    .filter((b): b is { type: "text"; text: string } => b.type === "text")
                    .map((b) => b.text)
                    .join("\n");
            }
            break;
        }
    }

    // Extract tool flow and stats
    const toolFlow: ToolStep[] = [];
    let model: string | undefined;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let finalAssistantText: string | undefined;

    for (const msg of messages) {
        if (msg.type === "user") {
            userMessages++;
        } else if (msg.type === "assistant") {
            assistantMessages++;
            const assistantMsg = msg as AssistantMessage;

            if (!model && assistantMsg.message.model) {
                model = assistantMsg.message.model;
            }

            for (const block of assistantMsg.message.content) {
                if (block.type === "tool_use") {
                    toolCalls++;
                    toolFlow.push(toolUseToStep(block as ToolUseBlock, toolFlow.length + 1));
                } else if (block.type === "text" && block.text.trim()) {
                    finalAssistantText = block.text;
                }
            }
        }
    }

    // Cross-reference parent session
    const parentFile = findParentSessionFile(agentFile);
    let spawnContext: AgentSpawnContext | undefined;

    if (parentFile) {
        spawnContext = await findSpawnContext(parentFile, firstUserMessage);
    }

    return {
        agentId: agentIdFromMsg || agentId,
        slug,
        model,
        parentSessionId: sessionId,
        parentSessionFile: parentFile || "unknown",
        agentFile,
        project: extractProjectName(agentFile),
        gitBranch,
        timestamp,
        spawnContext,
        toolFlow,
        firstUserMessage,
        finalAssistantText,
        messageStats: {
            userMessages,
            assistantMessages,
            toolCalls,
        },
    };
}
```

**Step 2: Verify compilation**

Run: `tsgo --noEmit | rg "agent-inspect"`
Expected: No errors

---

### Task 4: Add the formatting function

**Files:**
- Modify: `src/claude/lib/history/agent-inspect.ts`

**Step 1: Add markdown formatter for the inspect result**

```typescript
import { homedir } from "node:os";

export function formatAgentInspect(result: AgentInspectResult): string {
    const lines: string[] = [];
    const home = homedir();
    const shorten = (p: string) => p.replace(home, "~");

    // Header
    lines.push("## Subagent Details\n");

    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| **Agent ID** | \`${result.agentId}\` |`);

    if (result.slug) {
        lines.push(`| **Slug** | ${result.slug} |`);
    }

    if (result.model) {
        lines.push(`| **Model** | ${result.model} |`);
    }

    if (result.spawnContext) {
        lines.push(`| **Agent Type** | \`${result.spawnContext.subagentType}\` |`);
    }

    lines.push(`| **Parent Session** | \`${result.parentSessionId}\` |`);

    if (result.gitBranch) {
        lines.push(`| **Branch** | ${result.gitBranch} |`);
    }

    if (result.timestamp) {
        lines.push(`| **Started** | ${result.timestamp} |`);
    }

    lines.push(`| **Project** | ${result.project} |`);
    lines.push(`| **Messages** | ${result.messageStats.userMessages} user, ${result.messageStats.assistantMessages} assistant |`);
    lines.push(`| **Tool Calls** | ${result.messageStats.toolCalls} |`);
    lines.push(`| **Agent File** | \`${shorten(result.agentFile)}\` |`);
    lines.push("");

    // Spawn context
    if (result.spawnContext) {
        lines.push("### Spawn Context (from parent session)\n");
        lines.push(`- **subagent_type:** \`${result.spawnContext.subagentType}\``);
        lines.push(`- **description:** ${result.spawnContext.description}`);

        if (result.spawnContext.name) {
            lines.push(`- **name:** ${result.spawnContext.name}`);
        }

        if (result.spawnContext.mode) {
            lines.push(`- **mode:** ${result.spawnContext.mode}`);
        }

        if (result.spawnContext.model) {
            lines.push(`- **model override:** ${result.spawnContext.model}`);
        }

        if (result.spawnContext.isolation) {
            lines.push(`- **isolation:** ${result.spawnContext.isolation}`);
        }

        lines.push("");
        lines.push("**Prompt:**");

        const prompt = result.spawnContext.prompt;

        if (prompt.length > 1000) {
            lines.push(`\`\`\`\n${prompt.slice(0, 1000)}...\n\`\`\``);
        } else {
            lines.push(`\`\`\`\n${prompt}\n\`\`\``);
        }

        lines.push("");
    }

    // Tool flow
    if (result.toolFlow.length > 0) {
        lines.push("### Tool Flow\n");
        lines.push("| # | Tool | Details |");
        lines.push("|---|------|---------|");

        for (const step of result.toolFlow) {
            const escapedSummary = step.summary.replace(/\|/g, "\\|").replace(/\n/g, " ");
            const truncated = escapedSummary.length > 120
                ? `${escapedSummary.slice(0, 120)}...`
                : escapedSummary;
            lines.push(`| ${step.index} | ${step.tool} | ${truncated} |`);
        }

        lines.push("");
    }

    // Final output
    if (result.finalAssistantText) {
        lines.push("### Final Output\n");
        const text = result.finalAssistantText;

        if (text.length > 800) {
            lines.push(`${text.slice(0, 800)}...`);
        } else {
            lines.push(text);
        }

        lines.push("");
    }

    return lines.join("\n");
}
```

**Step 2: Verify compilation**

Run: `tsgo --noEmit | rg "agent-inspect"`
Expected: No errors

---

### Task 5: Register the `history agent` subcommand

**Files:**
- Modify: `src/claude/commands/history.ts`

**Step 1: Add the `agent` subcommand to history**

Add after the existing `historyCmd` action (before the dashboard command registration):

```typescript
import { formatAgentInspect, inspectAgent } from "@app/claude/lib/history/agent-inspect";

// In registerHistoryCommand(), after the main historyCmd .action() and before dashboard:

historyCmd
    .command("agent <agentId>")
    .description("Inspect a subagent: show spawn context, model, tool flow, and output")
    .option("--format <type>", "Output format: ai (default), json", "ai")
    .option("--full-prompt", "Show full spawn prompt without truncation")
    .action(async (agentId: string, options: { format: string; fullPrompt?: boolean }) => {
        const result = await inspectAgent(agentId);

        if (!result) {
            console.log(chalk.yellow(`No subagent found matching ID: ${agentId}`));
            console.log(chalk.dim("Tip: Use a partial agent ID (e.g., first 8+ chars)"));
            return;
        }

        if (options.format === "json") {
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log(formatAgentInspect(result, { fullPrompt: options.fullPrompt }));
        }
    });
```

Note: The `formatAgentInspect` function signature needs a second options arg. Update its signature in agent-inspect.ts:

```typescript
interface FormatOptions {
    fullPrompt?: boolean;
}

export function formatAgentInspect(result: AgentInspectResult, options: FormatOptions = {}): string {
    // ... in the prompt section, use options.fullPrompt to skip truncation
}
```

**Step 2: Verify compilation**

Run: `tsgo --noEmit | rg "history"`
Expected: No errors

---

### Task 6: Update the claude-history skill trigger

**Files:**
- Modify: `plugins/genesis-tools/.claude-plugin/skills/claude-history.md`

**Step 1: Add agent inspect to the skill's help output**

Add a section to the help/instructions showing the new subcommand:

```
## Agent Inspect

Inspect a subagent to see its full details:
```bash
tools claude history agent <agentId>
tools claude history agent a3da758cffecdd3f2
tools claude history agent a3da758 --format json
tools claude history agent a3da758 --full-prompt
```
```

**Step 2: Verify the skill file is valid markdown**

---

### Task 7: Manual smoke test

**Step 1: Test with a known agent ID**

Run: `./tools claude history agent a3da758cffecdd3f2`

Expected output (approximately):
```
## Subagent Details

| Field | Value |
|-------|-------|
| **Agent ID** | `a3da758cffecdd3f2` |
| **Slug** | groovy-sprouting-fairy |
| **Model** | claude-sonnet-4-6 |
| **Agent Type** | `code-reviewer` |
| **Parent Session** | `badfc772-7eca-4cea-bdcb-ec45837d21fb` |
| **Branch** | feat/claude-usage-tui |
...

### Spawn Context (from parent session)
- **subagent_type:** `code-reviewer`
- **description:** Review daemon tool implementation
...

### Tool Flow
| # | Tool | Details |
|---|------|---------|
| 1 | Bash | git -C /Users/Martin/Tresors/Projects/GenesisTools rev-parse --abbrev-ref HEAD |
| 2 | Read | src/daemon/lib/types.ts |
...
```

**Step 2: Test with JSON format**

Run: `./tools claude history agent a3da758cffecdd3f2 --format json | tools json`
Expected: Valid TOON/JSON output

**Step 3: Test with non-existent ID**

Run: `./tools claude history agent nonexistent123`
Expected: Yellow warning message

**Step 4: Commit**

```bash
git add src/claude/lib/history/agent-inspect.ts src/claude/commands/history.ts
git commit -m "feat(claude-history): add agent inspect subcommand"
```
