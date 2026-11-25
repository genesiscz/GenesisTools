---
status: Accepted
date: 2026-11-25
---

# Count agreeing speaker findings once per kind of evidence

A transcript shows a suggested name plainly at `global.suggest.applyAbove` and as a guess mark under it. Findings
that agree should add up, and the same reading must never count twice. `evidenceSources` in
`src/utils/meetings/range-strength.ts` names what a range rests on: the audio levels (the seat, the channel and the
energy rules), a voice match that led a rival, the platform's readings, the transcript's words, an agent's statement
or the user's answer. A speakers pass records, as `evidence.agreeing`, a labeler's finding beside an agent's one-line
range for the same person, and a rival-led voice match beside a calibrated seat name. `fusedConfidence` counts each
kind once, `1 - (1 - a)(1 - b)`, at most 0.95; the transcript and the question picker read it. The stated range
keeps its own confidence and rules.

Three guards come from the measurement. A voice match with no rival adds nothing: on held-out decided lines it was
right on 11 of 20, against 20 of 21 with a rival. The voice must lead its rival by `speakerLabels.fusion.voiceMargin`
(0.15): a lead of 0.12 named a person who never spoke. A rule's range that named the person before the agent stated
it adds nothing, because the agent could have read it: one such pair was wrong together. Adding up every agreeing
range at render time raised the plain wrong names, so it was not built.

`speakerLabels.fusion.mode: off` keeps each finding's own confidence. `speakerLabels.seat.retire: contradicted`
keeps a seat name that the calibrated share no longer supports unless the line names someone else. It is not the
default: the decided lines hold no such line, and the historical table gives lines under 70 % on the microphone to
the user on 5 % to 42 %.

`scripts/benchmarks/meetings/speaker-precision.ts` measures it on the lines people decided, with each meeting's
decisions and own voice samples left out. On 2026-11-25 (289 decided lines in 7 meetings) plain wrong names stayed
at 36, and the marks after a speakers pass fell from 2,036 to 2,025 on 6,356 lines.
