---
status: Accepted
date: 2026-11-18
---

# Ask one module who could have spoken a line

`speakersFor(line, facts)` returns a channel reading, ordered choices, exclusions with reasons and a review-only
flag for the full interval. Rules, scores, labels, merges and both question builders use it. A call majority is
below 0.5 mic share. Strong call evidence is at or below 0.35. Conflicting decisive readings are mixed. Separate
raw mute checks let the final merge reinstate an excluded speaker and could veto speech on another microphone.

`.claude/plans/2026-11-18-MeetingsRoomAndCallPresence.md`, "Interface freeze", "P2R: R2. Line eligibility, mute scope and editor hints", "P3R: R3. Rule integration, mic questions and one record update".
