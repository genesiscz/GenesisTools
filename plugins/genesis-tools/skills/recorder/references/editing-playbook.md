# Editing playbook: from a raw recording to a finished cut

Written 2026-11-07 from Martin's review of an agent-made demo edit (a scrolling iOS simulator movie). Every rule here
fixes a mistake that edit made. Read it before you edit any recording that you did not just record with demo mode.

## 1. Work on a copy

Never edit the only edit of a recording. Duplicate the project first (`movie.duplicate()` / `tools recorder duplicate`
when present; otherwise copy the folder with `cp -c` and point the copy's `edit.json` paths at the copy). Name the
copy after what it is for ("demo-cut-sonnet-r1").

## 2. Survey before you decide anything

You cannot place an effect on a moment you have not seen.

1. `m.info()` for the length and what the edit already holds.
2. `m.sheet({ count: 12 })` over the whole movie, then a sheet per interesting stretch (`from`, `to`).
3. `m.events()` (scene changes, scrolls, still stretches, clicks) when present. Without it, find the moments yourself:
   a dense sheet (every 0.5 s) over a stretch shows where the screen changes. Write the list down as a table of
   source seconds with what happens ("49.2 s: the solar detail opens").
4. Read the screen text where privacy matters (`m.findOnScreen`, or OCR the stills).

## 3. Place every effect on an event, never on a guess

- A zoom, spotlight or callout starts 0.2 to 0.4 s BEFORE the moment it explains (the tap, the screen change) and ends
  after the viewer had time to read it. A zoom that starts after the screen changed is late.
- The zoom's focus is the thing you talk about, measured from a still at that time (the rect of the element), not the
  centre of the screen. Check the zoomed still: the thing must be inside the view with margin, and the zoom must not
  cut it in half.
- Prefer a lens or a spotlight to a zoom when the context around the thing matters.

## 4. Privacy: hide the text, not a box of the screen

- Content that moves (scrolls, screen changes) cannot be hidden with a fixed box for a fixed time. Use tracked
  redactions (`m.hideText({ text | pattern })`, the private-data detector) when present; they follow the text and
  start and end with it.
- Without tracking: one box per still stretch only. Split the time at every scroll and screen change from the event
  list, and give each stretch its own box measured on a still from that stretch. Never cover a whole scrolling screen
  with one pixelate box; cut that part, speed it up, or show it blurred as a deliberate effect.
- Leave out what does not move with the content (a toast, a tab bar, the status bar) with `exclude` when present.
- A box must never stay on after its text left: it then blurs the next screen's harmless content.
- Verify after the export: `m.verifyHidden({ text | pattern })` when present; otherwise OCR stills of the OUTPUT every
  0.5 s through each hidden stretch and look for the text. A leak found after delivery is a failed edit.

## 5. Layout of portrait footage

- A phone (9:16) in a 16:9 frame leaves most of the picture empty. Choose the frame aspect from the source (9:16 or 4:5
  for a phone), or use the empty side for titles and callouts on purpose.
- Titles and callouts never cover the app's own text or the status bar. Place them in the frame's padding or beside the
  phone.

## 6. Do not point at failures

Test environments show error toasts and empty values. Close developer toasts before you record. In the edit, do not
spotlight, zoom or box an error state unless the video is about that error; cut or hide those moments instead.

## 7. Sound

- Voiceover lines are clips placed at source times (`m.voiceover`, `m.say`), so they move with cuts and speed changes.
  Never premix voice and music outside the editor when clips exist.
- Music under speech ducks (`m.ducking({ db: 12 })`). Generate or pick music the user may use; never a commercial song.
- Write each line for the moment it plays: one idea, at most about 2.5 words per second of the stretch it covers.

## 8. Check every boundary before you export

For each effect: a still 0.1 s before its start, at its start, in its middle, at its end and 0.1 s after. Look at them
(a sheet with `times`). Typical misses: a blur on before its text appears, a zoom late or off target, a title over the
status bar, an effect left on into the next screen.

## 9. Score your own cut before you hand it over

Score 0 to 10 against this list: timing on events (2), privacy with no leak and no over-blur (2), framing and layout
(2), story (title, chapters, callouts that explain) (2), sound (voice clear, music ducked, no clipping) (2). Name what
cost each lost point. Fix what you can and score again. Hand over the score with the cut.
