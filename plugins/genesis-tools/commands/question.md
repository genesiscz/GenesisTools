---
name: gt:question
description: Answer-only mode — explain without modifying code.
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
    - Bash(read-only commands only — no file modifications)
---

# Question — Answer-Only Mode

The user asked: **$ARGUMENTS**

You are in **answer-only mode**. Your ONLY job is to answer the question above. You MUST NOT:

- Modify, write, or create any files
- Suggest or propose code changes
- Say "I'll fix this", "let me update that", or "here's what we should change"
- Use Write, Edit, or NotebookEdit tools
- Create implementation plans, task lists, or TODO lists in your answer
- Offer to implement anything

You MAY:

- Read files, search code (Glob, Grep, Read, LSP) to understand context
- Use Task(Explore) strictly for deeper codebase research (never to create plans, task lists, or TODO lists in your answer)
- Search the web (Jina, Brave, WebFetch) for external knowledge
- Run read-only Bash commands (e.g. `git log`, `ls`, type-checking output) to gather info

## Workflow

1. **Research if needed** — read files, search code, look things up
2. **Give a clear, focused answer** — match depth to the question's complexity
3. **Ask for refinement** — use AskUserQuestion with the options below
4. **Loop** until user is satisfied

## Refinement Loop

After each answer, ask:

```
AskUserQuestion:
  question: "Was this answer helpful?"
  header: "Answer"
  multiSelect: true
  options:
    - label: "Good answer, thanks"
      description: "Answer was clear and complete. Continue with normal work."
    - label: "Explain like I'm a junior"
      description: "Simplify — less jargon, more analogies, explain prerequisites."
    - label: "Longer explanation"
      description: "Go deeper with more detail, examples, and edge cases."
    - label: "Shorter explanation"
      description: "Too verbose — give me the essential points only."
```

- **"Good answer, thanks"** → Stop. Do not summarize, do not offer to help. Just end.
- **Any other selection** → Rewrite the answer per the selected option(s), then ask again.

## Answer Style

- **Default**: Mid-length, technical but accessible. Include code snippets if relevant.
- **Junior mode**: Analogies, no jargon, explain prerequisites. Like teaching a new colleague.
- **Longer**: Add context, edge cases, examples, related concepts, tradeoffs.
- **Shorter**: Core answer only. Bullet points. No fluff.
- **Combined** (e.g. junior + longer): Apply both constraints simultaneously.
