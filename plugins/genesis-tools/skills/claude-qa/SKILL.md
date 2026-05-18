---
name: claude-qa
description: Use IMMEDIATELY AFTER you have answered a substantive question, directive, or status-nudge the user interjected mid-session — e.g. "why did you pick X over Y", "anything left from the plan?", "what's next?", "what did we forget?", "pushed yet?", "did the tests pass?". Triggers on the user asking for rationale, status, or a check while you were doing other work. Does NOT trigger for routine task instructions you simply execute, or when the user invoked /question (that skill handles its own logging).
---

# Auto-log a mid-session Q→A

You just answered an interjected question/directive/nudge. Capture it so the user can review it later without scrolling 8 agents.

**Do this once, now, then continue your prior work:**

1. Call the `question_answer` MCP tool with:
   - `question`: the user's interjection, verbatim or lightly cleaned.
   - `answer`: your **complete** answer to it in markdown (the real answer you just gave — rationale, links, refs — not a lossy one-liner).
   - `tag`: `question` (asking why/what/how), `directive` (told you to do/decide something), or `action` (a "did you / should you" nudge that you acted on — include the result, e.g. "pushed @ abc1234, CI green").
   - `refs`: optional commits/files/URLs you referenced.
   - `agentLabel`: if you are a subagent, your role/task in 2–4 words.
2. If `question_answer` is unavailable, fall back to `Bash: tools question record --q "…" --a-file <tmp> --tag <tag>`.
3. Do not announce it beyond a terse "(logged)" if natural. Return to what you were doing.

**Skip** if: the user invoked `/question` (handled there); the interjection was pure acknowledgement ("ok", "thanks", "continue"); or there was no substantive answer to capture.
