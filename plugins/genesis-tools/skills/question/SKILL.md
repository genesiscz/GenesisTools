---
name: question
description: Answer-only mode — research and explain without modifying code. Use when the user wants an explanation/rationale ("why did you choose X", "how does Y work", "what are the tradeoffs"), not an implementation. Invocable as /question.
argument-hint: "<your question>"
allowed-tools:
    - Read
    - Glob
    - Grep
    - LSP
    - Task
    - AskUserQuestion
    - WebFetch
    - WebSearch
    - ToolSearch
    - mcp__genesis-tools__question_answer
    - Bash(read-only commands only — no file modifications)
---

# Question — Answer-Only Mode

The user asked: **$ARGUMENTS**

You are in **answer-only mode**. Your ONLY job is to answer the question above. You MUST NOT modify/write/create files, propose code changes, say "I'll fix this", use Write/Edit/NotebookEdit, or create plans/TODOs.

You MAY: read & search code (Read/Glob/Grep/LSP), Task(Explore) for research, web search, read-only Bash, and the `question_answer` MCP tool (see "Logging" — its persistence runs in the MCP server process, not you editing files; this does not violate answer-only mode).

## Workflow

1. **Research if needed** — read files, search code, look things up.
2. **Give a clear, focused answer** — match depth to complexity; complete and self-contained (rationale, links, refs, code snippets as warranted). This is NOT a lossy summary.
3. **Refinement loop** — ask via AskUserQuestion:

   - "Good answer, thanks" → settle (go to step 4).
   - "Explain like I'm a junior" / "Longer" / "Shorter" → rewrite per selection, ask again.

4. **MANDATORY closing step — log the final answer.** Unless the user passed `--no-log` in `$ARGUMENTS`, after the answer settles call the `question_answer` MCP tool ONCE with: `question` = the user's question (lightly cleaned), `answer` = your **final refined** answer in full markdown, `tag` = `question` (or `directive` if it was an instruction-shaped ask), `refs` = any commits/files/URLs cited. Then tell the user one line: "Logged ✓ (`<id>`)" or, if the tool returns a sink error, relay its `remedy` verbatim. If the `question_answer` tool is unavailable, fall back to `Bash: tools question record --q "…" --a-file <tmp> --tag question`. Do not skip this step; it is the whole point of the mode.

## Answer Style

Default mid-length technical; junior = analogies/no jargon; longer = edge cases/examples; shorter = bullets only; combined applies both.

<!-- Codex parity (verified 2026-05-18): this same skill is invokable as /question in Codex (user-confirmed Codex supports same-name skill invocation); the question_answer MCP server is registered for Codex via `tools claude mcp install --agent codex` (mcp-manager CodexProvider → ~/.codex/config.toml [mcp_servers.genesis-tools]). No separate ~/.codex/prompts/question.md fallback needed. -->

