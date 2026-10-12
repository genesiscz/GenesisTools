# Annotated before/after screenshots

The deliverable: a markdown note where every before/after pair says in one or two sentences what to look for, and
both images carry marks that show it. Red marks a real change. Amber marks what is not a change: different data, a
snapshot limit, or an expected change this shot cannot show. A reader who has never seen the code must find every
change in seconds.

A raw pair is not enough. A before and an after are taken at different times, so they show different sessions,
counts, times and commit states. Without marks the reader cannot tell a fix from a new row of data.

## 1. Capture the pair fairly

Rules, each learned the hard way:

- **Same command, same window size, same scale.** Take the after with the before's exact command plus an explicit
  size. Hub: `--width 2056 --height 1290`. Never rely on a binary's default window: a debug build and the installed
  app open different sizes, and the after then looks zoomed in.
- **Check both files before anything else:** `sips -g pixelWidth -g pixelHeight before.png after.png`. When one side
  is 2x and the other 1x, resample the 2x side: `sips --resampleWidth <1x width> after.png`.
- **Off screen, never the user's windows.** Hub: `GenesisTools --hub --mode <m> [--session <id>] --width W --height H
  --snapshot <png>`. Settings: `GenesisTools --clicky --page <page id> --snapshot <png>` (needs the installed bundle).
  Widget: `bun scripts/native/widget-drive.ts record …` or `tools control capture` by window id.
- **One pane alone needs `--panes <name>`.** The hub's session view shows panes side by side; `--tab` only picks the
  focused pane. A pair taken with `--tab changes` on a new build shows the transcript.
- **Know what a snapshot cannot draw.** `cacheDisplay` (the hub and review `--snapshot`) drops Liquid Glass
  (`.glassEffect`) and everything drawn under it, so a page with glass comes out transparent; settings snapshots
  capture from the window server instead (`WindowSnapshot`, e8bd413c5), which needs Screen Recording. Before you call
  a blank area a snapshot limit, prove it: retake with a longer `--snapshot-delay`, then with another theme; a blank
  that survives both is a capture limit. The digest is captured while
  "Reading the day…" still loads; a long check may still run. Mark those amber, never as a change.
- **Write the capture command next to the pair** (a `capture.txt` or the note), so the next person can retake it.
- **Names:** `<YYYY-MM-DD-HHMM>-<area>-<slug>-before.png` and `-after.png` in the area's `Screenshot/` folder of the
  project's notes folder (`GenesisTools/GenesisTools.native/<Area>/Screenshot/`; the global instructions name where
  the notes folder lives).

## 2. Write down what changed before you look

The image cannot tell you what changed. The fix reports and commits can.

- When a brief lists the changes, that list is your source. Otherwise build it per pair from the bug ids, the fix
  report and `git log` / `git show --stat` of the touched files: `<id>: <old> → <new>, where on the screen`.
- Then check each item against the images. **The image is the truth**: an expected change that the after does not
  show gets an amber "not visible here" mark or a sentence in the note, never a red box where you hope it is.
- **When the image contradicts the change list** (the list says stale sessions fold away, the after still lists rows
  that are days old), mark what the image shows and write the contradiction in the note. Never bend a mark to fit the
  list; the contradiction may be a bug.
- When two icons differ and their meaning is not obvious (wrap on or off, a shield or a gear), confirm the meaning in
  the code (the SF Symbol name in the view) before you label it. Without access to the code, use the brief's words
  and describe what you see; never invent a meaning.
- `tools control compare-screenshot a.png b.png --diff-out diff.png` helps only when both sides show the SAME data.
  With different data it marks almost everything; do not use it to find changes then.
- Its threshold also hides a change of tint. Hub vs Native · Gradient measured 0.15 % mismatch while the empty
  background went from rgb 24,24,25 to 43,37,45. For a colour or theme change, compare the mean colour of an empty
  region (a few lines of `pngjs`), not the mismatch percentage.

## 3. Find exact coordinates

Coordinates are natural image pixels. Never guess them, and never read them off a scaled-down view: Read shows an
image wider than about 2000 px scaled down (a scale notice such as "1.03" means the same).

0. **Find the region first.** Read the whole image once only to see roughly where each element sits (a quarter,
   a pane, the header row). Then crop that region with a margin of about 100 px and measure only on the crop.

1. **Crop first, into a new file**, then lay a labelled grid over the crop. Grid labels are drawn along the image's
   top and left edges, so a `crop` inside the same plan cuts them off. `originOffset` makes the labels absolute:

   ```bash
   # sips -c <height> <width> --cropOffset <y> <x>
   sips -c 600 1200 --cropOffset 400 2600 after.png --out /tmp/…/after-crop.png
   tools control draw /tmp/…/after-crop.png --out /tmp/…/after-crop-grid.png \
     --annotate '{"annotations":[{"kind":"grid","step":100,"originOffset":{"x":2600,"y":400}}]}'
   ```

   Read the result. The labels now read 2700, 2800… across and 400, 500… down: absolute coordinates of the original.

   ⚠️ Never pass a 0 in `--cropOffset`. `0 0` silently returns the CENTRE crop, and a single 0 misbehaves too. Use 1:
   one pixel off the edge does not matter for measuring. Or skip sips for a crop at the top or left edge: one `draw`
   plan with the grid and then a `crop` keeps the labels, because that crop includes the image's own edges.
2. **Step and crop size:** keep a crop at most about 1600 px wide so Read shows it 1:1. Pick the step from the crop's
   SHORTER side: 600 px or more, step 100; 300 to 600 px, step 50; under 300 px, step 25. Labels of neighbouring
   lines collide below step 50 on the x axis, so for a wide but short crop use step 50 and read the y labels. For
   larger labels add `"style":{"fontSize":20}` to the grid.
3. Read the labels next to the element: its left, top, right and bottom give `x, y, w, h`.
4. A 2x image (4112 x 2580) has every point twice: an element at 340 pt is at 680 px. Measuring a width this way is
   also how you prove a size change (a pane edge at x 3013 before and x 3351 after is 1099 px vs 761 px).

## 4. Draw

One plan per image, run with `tools control draw <image> --annotate <plan.json> --out <annotated.png>`. The original
is never changed. The MCP tool `annotate_image` takes the same plan.

```json
{"preset":"review-red","annotations":[
  {"kind":"highlight","rect":{"x":690,"y":78,"w":62,"h":56},"style":{"strokeWidth":8},
   "label":{"text":"H19: gear for settings","position":"bottom-left","style":{"fontSize":40}}},
  {"kind":"highlight","rect":{"x":3351,"y":40,"w":761,"h":2540},"style":{"strokeWidth":8},
   "label":{"text":"H18: capped at 380 pt","position":"bottom-left","style":{"fontSize":40}}},
  {"kind":"highlight","rect":{"x":1500,"y":940,"w":420,"h":110},
   "style":{"stroke":"#ffb020","fill":"rgba(255,176,32,0.10)","strokeWidth":8},
   "label":{"text":"data only: nothing uncommitted now","position":"bottom","style":{"bg":"#ffb020","fg":"#111111","fontSize":40}}},
  {"kind":"arrow","from":{"x":2200,"y":30},"to":{"x":2330,"y":30},"style":{"strokeWidth":6}},
  {"kind":"label","at":{"x":1700,"y":10},"text":"H12: not visible here","style":{"bg":"#ffb020","fg":"#111111","fontSize":40}}
]}
```

The kinds:

- `highlight` `{rect, style?, label?}`: rounded box with a light wash. The main mark.
- `label` `{at, text, style?}`: a chip with its top-left corner at `at`. Use it when the box has no room for its own
  label; join it to the element with an `arrow`.
- `arrow` `{from, to, style?}`: points at something too small to box or at a chip placed away from its element.
- `box` (square corners), `ellipse` (round controls), `blur` `{rect, strength?}` (secrets: tokens, other people's
  emails).
- `grid` `{step?, originOffset?, labels?, style?}` and `crop` `{rect}`: for measuring (section 3). A crop is applied
  last, whatever its place in the list.

Where a box's label lands: `top-left`, `top`, `top-right` put the chip just above the box; `bottom-left`, `bottom`,
`bottom-right` just below it; left, centre or right says which edge it aligns to. Exception: when the box is within
about 1.5 x fontSize of the image's top or bottom edge, the chip is pushed INSIDE the box. Near the top edge use a
`bottom-*` position; when neither side has room, place a `label` chip in empty space and join it with an `arrow`.

Rules:

- **Red** (`review-red`, the default): a real change. Mark the defect on the before AND the fixed spot on the after,
  with the same id on both. When the change is an effect (long lines run past the edge), box the control that causes
  it and name the effect in the label.
- **Amber** (stroke `#ffb020`, fill `rgba(255,176,32,0.10)`, chip bg `#ffb020`, fg `#111111`, the same strokeWidth as
  red): not a change. Three uses, each with a fixed wording:
  - different data: "data only: <what>" (another session, other counts);
  - a snapshot limit: "snapshot limit: <what>" (a blank list, a check still running);
  - an expected change this shot cannot show: "<id> <what>: not visible here" ("H15 dot byte sizes: not visible
    here"). Point it at the element whose state would show it (an `arrow` to the chip, the empty list); with no such
    element, put it in the area where the change would appear. A bare "H15: not visible here" tells the reader nothing.
  One or two amber marks per image at most; skip data differences that would not mislead.
- **Blank areas of a snapshot are transparent** (alpha 0: a list it cannot draw). A wash there turns into a solid
  block of colour in a viewer that ignores alpha, and Read shows alpha 0 as black. Give a mark over a blank area
  `"fill":"rgba(0,0,0,0)"`: the outline and the chip are enough.
- **Grey label** (bg `#555555`, fg `#ffffff`): orientation only, e.g. "frame 12" in a filmstrip.
- **Size the marks to the image width:**
  - over 2600 px (2x shots): strokeWidth 8, fontSize 40;
  - 1200 to 2600 px (1x shots): strokeWidth 5, fontSize 24;
  - under 1200 px (widget shots, small windows): strokeWidth 3, fontSize 16.
- **Label text:** `<id>: <what is true on this side>` in a few words. Before: the defect ("H12: chip says 4 days
  ago"). After: the fix ("H12: as of 4d ago, dim"). No id: use the brief's term or the commit subject in three words
  ("padding fix: header inside").
- **Place the box on the element, about 6 px around it.** An element cut by the image edge: draw the box flush with
  that edge and say "cut off" in the label.
- **A chip covers nothing it is not about.** It must not sit on another box, its border, the element it explains or
  any content (text, data columns). Put chips on empty space: margins, an empty pane, the gap between rows.
  Two boxes closer than about 1.5 x fontSize: put one label on the other side (top vs bottom), or use a `label` chip
  in empty space with an `arrow`, or merge the two into one box with one label. Beside dense list rows, put the chip
  in the nearest empty gutter or header band and join it with an `arrow`. Chips must not overlap each other either.
- **When one region holds both a change and data** (session rows that moved down): red on the edge or spacing that
  changed, amber on the content.
- **Every item of the change list gets a mark** on each side where it shows. Keep an image to about five marks by
  merging items that sit in one area: one box, one label listing them ("H11: brief times, H19: dim glyphs"). Never
  drop an item to stay under five; a sixth mark is better than a missing change.

## 5. Verify every image

- Read each annotated PNG. Every box must sit on its element, every label must be readable and cover nothing marked.
  A 2x image is scaled down in Read: check it in quadrant crops at 1:1 (`sips -c … --cropOffset …` into scratch).
  Fix the plan and draw again; it costs seconds.
- The originals must be unchanged: compare `shasum` before and after the run.
- List what you could not mark and why (the after does not show that state, the snapshot cannot draw it).

## 6. Write the note

Default places (a brief may name others; then the brief wins): annotated copies in
`<Area>/Screenshot/annotated/NN-<area>-<slug>-before.png` / `-after.png`, the note in
`<Area>/YYYY-MM-DD-BeforeAfter.annotated.md`. `NN` is the pair's number in the note, 01 for a single pair.

- A header: what the pairs cover, the legend (red, amber with its three uses), why data differs, the known gaps.
- Per pair: the before and the after side by side in one two-column row (each half the reading width in Genesis and
  Obsidian), then what every id on the pair means, so the reader never looks an id up elsewhere. Take each meaning
  from the report that defined the id (its heading or ledger line), not from memory:

  ```markdown
  ### 03 Hub: Transcript, Changes and Files panes together

  Look at the Files pane: it took about 550 pt for three file names and is now capped at 380 pt. The wrap button
  now starts in wrap mode, and the settings button is a gear. The empty Changes pane is data: nothing is uncommitted now.

  | Before | After |
  | --- | --- |
  | ![before](../Hub/Screenshot/annotated/03-hub-sessions-3panes-before.png) | ![after](../Hub/Screenshot/annotated/03-hub-sessions-3panes-after.png) |

  **What the ids mean**

  - **H18** Diff panes clip long lines when three panes are open
  - **H19** Small label and icon problems
  - **H12** "Weekly 100% · 4 days ago" reads as fresh data

  Fixes: H18 and H19 in **501890e78**. Not visible here: H12 (the chip shows another usage window).
  ```

  Never put an Obsidian size suffix (`![a|50](…)`) inside a table row: its `|` splits the cell.

- Embed paths are relative to the note file. Check that every embed resolves: a missing file renders as nothing.
- A note in the vault: open it in Obsidian and Genesis (`obsidian-cli open "<vault path without .md>"`,
  `genesis open <absolute path>`).

## 7. Show pairs side by side in Preview

One `open` with each before right next to its after. Preview skips files already open in another window and sorts
by name, so copy the pairs into a fresh folder with ordered names:

```bash
# NN-<area>-<slug>-1-before.png, NN-<area>-<slug>-2-after.png, one line each in order.txt
tr '\n' '\0' < order.txt | xargs -0 open
```

The same trick shows variants of one screen (Hub, Native Glass, Native Solid, Native Gradient): name them
`<mode>-1-…`, `<mode>-2-…`, all at one size and scale, and the arrow keys flip between them without a zoom jump.

## Checklist

- [ ] Both sides: same command, same pt size, same scale (`sips`); capture command written down.
- [ ] Expected changes listed per pair (brief, or ids, reports and commits) before looking.
- [ ] Coordinates from a grid on a separate crop with `originOffset`, never guessed.
- [ ] Red on the defect (before) and the fix (after) with the same id; amber only for data, snapshot limits and
      "not visible here", with the fixed wording.
- [ ] Marks sized to the image width; no chip on another box or on what it explains.
- [ ] Every annotated image read back at 1:1; originals unchanged (`shasum`).
- [ ] Note: header with legend and gaps, per pair "what to look for", the pair side by side, every id explained under
      it, embeds resolve, fixes and commits named.
