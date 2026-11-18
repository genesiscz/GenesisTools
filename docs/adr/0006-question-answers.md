---
status: Accepted
date: 2026-11-18
---

# Separate question construction from answering

`questions.ts` owns question construction, including the group builder, `openQuestions` and the view helpers.
`question-answers.ts` owns the effects of answering, skipping, splitting and propagating a question. The
decision journal invokes those effects. A third module for the small view helpers would expose nearly every
helper individually and hide little behavior.

`.claude/plans/2026-11-18-MeetingsArchitecture.md`, "`question-answers.ts` (P4A): moved, signatures unchanged", "P4A: A4. Question answers move into their own module".
