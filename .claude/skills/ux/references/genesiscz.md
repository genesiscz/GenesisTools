# What genesiscz wants from a UI

The maintainer of GenesisTools (genesiscz) reviews every surface by using it for real, usually in the middle of a
task, often with agents working beside them. Their requests come as screenshots with a list of what got in the way.
This file generalizes those requests into principles, so an agent can find the next gap of the same kind before they
have to point at it. Each principle names where it came from; `SKILL.md` ("What Martin asks for") holds the older,
widget-specific lines.

Use it two ways: before you design or change a surface (do these without being asked), and when you audit one (each
principle is a question to ask of every view).

## 1. One engine per concept, every surface reaches it

A behavior the CLI already has (a bounded clip with a tone, an answer with choices and a comment, the look-alikes one
answer settles) is the behavior the window has, through the same TypeScript code. A second implementation in Swift
always drifts and always misses something: the meetings window played audio from a time to the end with no tone,
while `tools meetings listen` cut a clip and beeped at the asked point (2026-11-09).

Ask: does this view call the engine the CLI calls, or does it rebuild part of it? What does the CLI do that the view
does not?

## 2. Nothing moves under the pointer or the eye

A confirmation, an error or a new row never pushes content. Notices float over the content (the GenesisKit notice,
with Undo, for a configurable time, 30 s for a decision). An answered or removed row keeps its place, marks itself
and folds its controls with a short animation; it does not vanish and pull the list up. Lists never reorder while they
read them.

Ask: after each action, is the next thing they want to look at still where it was?

## 3. Every reference is live

A time is a play button for that span. A count opens what it counts. A file, a commit, a frame, a document line, a
person is a link to it. A reference they have to copy and look up by hand is a defect.

Ask: which text on screen names something they could want to see or hear, and does a click give it to them?

## 4. Show the moment, not the whole stream

Audio or video plays a bounded span around the point in question, with the point marked (a marker on a timeline, a
tone) and a way to jump straight to it. Never play to the end by default, never make them wait 5 to 10 s for the part
that matters. Zooming out, switching views or opening details never stops what plays.

## 5. A question says what it asks at a glance

A question or decision is structured: who, what was said, when, what it decides, the choices. Bullet points, the
quoted text set apart from the explanation, the decisive part first. If they must read a whole paragraph to learn
what is being asked, it is a defect. The answer controls sit next to the question, with the likely answer first.

## 6. Answer in place, fast, and reversibly

The common action is one click or one key; editing a suggestion happens in its row (double click or Return), with
an own answer and a comment always possible. After an answer the chosen control stays highlighted, the next item
comes up by itself (it plays, it is selected), and every answer has Undo or "Revert and edit" right there.

## 7. One component per concept

The same thing looks and behaves the same everywhere: one play control, one row, one notice, one timeline. Two
buttons that do the same thing with two designs (a "Play" button on questions, a bare time link on items) are a
defect even when both work. Shared pieces live in GenesisKit.

## 8. Opinionated means configurable, near where it acts

Every choice a reasonable user could want another way (how much context to play, a tone and its sound, autoplay,
how long a notice stays, a placement, an order) is a setting with the best pick as its default
(`.claude/rules/opinionated-settings.md`). For a working surface they want those settings reachable from the surface
itself (a side panel or popover), not only in a far Settings window.

## 9. Say what the system knows, and what an action will also change

If the engine knows that one fix also affects other items, sections or meetings, the action says so before it
happens and lets them choose: "Just this" or a selection, each part checkable on the spot (playable, viewable). A
merge or a rename names what it touches. Silent side effects and silent no-ops are defects.

## 10. Build from what is already known

Inputs complete from the data the system already has (calendar people, contacts, earlier meetings, project names)
and still accept a new value. A list of people, projects or terms that exists in three places is one list they can
manage (add, merge, rename) in one view.

## 11. Windows stay where they put them; agents never take their place

A floating panel they opened stays open until they close it; focus moving to another app (often an agent's) does not
close it (the capture picker, 2026-11-09). Background work never steals focus or moves their pointer.

## 12. Failures are readable and actionable

An error shows what failed, why, and the next step, in the surface's own style, with buttons such as "Copy context
for agents" or "Draft an issue" (the recorder failure notice, 2026-11-09). Raw stderr in grey text is a defect.

## 13. More data, shown honestly

When the system reads less than is there (OCR missing small text, a transcript missing a stretch), they want it to
read more, and the view to show both what changed and everything it read ("All text" beside "Changed lines",
2026-11-09), with the counts.

## How to use this in an audit

For each view: walk principles 1 to 13 as questions, note each gap with the screenshot or the code line, score it 1
to 10 by how often they would meet it and how much it slows them, and propose the fix in terms of the shared engine and
GenesisKit component it should use. Find gaps of the same kind as their examples; do not stop at their examples.
