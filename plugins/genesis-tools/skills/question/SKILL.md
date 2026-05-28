---
name: question
description: Answer a question and preserve the Q→A for later review. Use when the user runs `/question <x>` (answer it, then save), or right after you give a substantive answer worth keeping to a question interjected mid-session ("why X over Y", "how does Y work", decisions, rationale, tradeoffs). Not for routine instructions you execute or quick status checks/acknowledgements ("ok", "thanks", "pushed yet?").
argument-hint: "<your question>"
---

# Question — answer & preserve

This fires two ways. Branch on whether `$ARGUMENTS` is present:

**A. Direct invocation — `$ARGUMENTS` is set.** The user asked: **$ARGUMENTS**
Research if needed (read/search code, look things up), then give a clear, focused, self-contained answer — rationale, links, refs as warranted. Then preserve it (see **Log**).

**B. Auto-trigger — `$ARGUMENTS` is empty.** You just answered a substantive question/directive/nudge the user interjected while you were doing other work. Capture that Q→A so they can review it later without scrolling back, then return to your prior work.

## Log — the whole point

Call the `question_answer` MCP tool ONCE with:

- `question`: the user's question, verbatim or lightly cleaned.
- `answer`: your **complete** answer in markdown (the real answer — rationale, links, refs — not a lossy one-liner).
- `tag`: `question` (asking why/what/how), `directive` (told you to do/decide something), or `action` (a "did you / should you" nudge you acted on — include the result, e.g. "pushed @ abc1234, CI green").
- `refs`: optional commits/files/URLs you referenced.
- `agentLabel`: if you are a subagent, your role/task in 2–4 words.

If the `question_answer` MCP tool is unavailable, fall back to the CLI:

```bash
tools question record --q "<question>" --a-file <tmp-file-with-answer> --tag <tag>
```

Then tell the user one line — "Logged ✓ (`<id>`)" — or, if the tool returns a sink error, relay its `remedy` verbatim.

**Skip logging** if: the interjection was pure acknowledgement ("ok", "thanks", "continue"); there was no substantive answer to capture; or the user passed `--no-log` in `$ARGUMENTS`.
