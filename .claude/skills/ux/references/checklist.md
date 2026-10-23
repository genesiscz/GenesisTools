# Shippable checklist for a native view

Walk it for every view you change. Each line exists because it was missed at least once.

## Affordance
- Every clickable thing shows the pointer cursor on hover and has a hover state. The hand comes from the shared styles
  (`genHover*`, `RowButtonStyle`, `MenuButton`); `.plain`, `.borderless` and a SwiftUI `Menu` have none.
- The whole row toggles a disclosure: text, icon and chevron, not the chevron alone. Use `GenDisclosure`, never
  `DisclosureGroup`, and test a click at the far right edge of the row.
- Icon-only buttons have an instant tooltip and an accessibility label.
- Media shows a real preview (image thumbnail, video poster with duration) through GenesisKit `MediaThumbnailView`;
  a click previews in place (`.mediaPreviewHost()`), and Esc closes the preview before the panel. An icon is only for
  a failed load, and then it says what failed and offers a retry.
- Images inside agent text are lifted into the card's typed `attachments` in the snapshot (TS), never parsed in the
  view: SwiftUI `Text(.init(markdown))` never draws an image.
- Items that can be acted on can be acted on in place: tick a task, expand an answer, create a new one.
  Opening another window is the exception, not the default.

## Windows and overlays (Martin, 2026-10-14)
- No `isMovableByWindowBackground` on a window with SwiftUI content: the hosting view counts as background
  everywhere, so a held press on any control turns into a window drag and can leave SwiftUI waiting for a mouse-up.
  Drag regions are explicit: `.titlebarZone()` or a dedicated AppKit drag view.
- A custom AppKit view that can become first responder (a divider, a splitter) does so only with keyboard navigation
  on, and never draws the default focus ring over content.
- Anything that appears over the user's work by itself (a nag, a HUD, a pill) has a setting to turn it off and can be
  dragged away; it keeps its place per display and comes back fully on screen.
- A movable overlay tracks the drag in its own `mouseDragged` from each event's location and saves on mouse-up;
  `performDrag(with:)` moved a panel only on the first drag of a show.
- ⌘W closes the current tab; on a window with no tabs left it closes the window.

## Layout
- Equal, intentional insets on all four sides; controls aligned in one column; descriptions under titles.
- Panels size to their content up to a maximum; no large empty band above a composer. When something opens inside
  (a card, Source and context, "Show all"), the panel grows with it up to that maximum and only the rest scrolls;
  closing it shrinks the panel back.
- Every expand and collapse animates with GenesisKit `GenMotion` (one curve, 0.24 s open, 0.2 s close, instant
  under Reduce Motion): `GenDisclosure`, or a hand-made row's toggle in `GenMotion.perform` with the revealed view
  `.transition(.genReveal)` and the row clipped. Exceptions are deliberate: keyboard folds, "Show N more" pages
  above `GenMotion.maxAnimatedRows`, transcript `List` rows.
- Nothing is cut off: overflowing content scrolls with an edge cue (`.scrollOverflowContent()` +
  `.scrollOverflowHints()`); `.scrollIndicators(.visible)` does not keep overlay scrollers visible. The last row
  and badges are fully visible at the smallest window size.
- Segmented tabs in a non-activating panel: the native `Picker` greys its selection out of the key window; use
  `GenSegmentedTabs`.
- One navigation per surface; no two controls that do the same thing side by side.
- Distinct icons for distinct features (two modules once shared `waveform`).

## Widget and panel controls (Martin, 2026-10-23 14:40)
- A text field inside a padded box: the whole box focuses the field (`.contentShape` + `.onTapGesture { focus = true }`
  on the box); a click beside or under the one-line field did nothing.
- A button that opened something closes it on a second click when what it opened is still on screen (a rail
  session's inbox, the inbox overview). A second click that does nothing reads as a dead control.
- A count leads to the list of exactly what it counts. "35 need you" over 4 rows, and "99+ unread" that opened one
  arbitrary session, are both defects: the count opens a list of every counted item (scrollable, filterable), and
  each item says which session it belongs to (name, project, short id) and how to get there.
- Every session row offers a way to its terminal: the cmux button with GenesisKit `CmuxSessionPanel` (focus, open
  in its last pane, choose a pane), one shared component in the hub and the widget.
- A list's filter and order live next to the list, with a settings shortcut that opens the page at the card and
  pulses it (`<page>#<anchor>` + `.nativeSettingsAnchor(id)`, GenesisKit `AttentionPulse`).
- One row style for every top-level item of a list. Sessions with sub-agents drew as disclosure headers and sessions
  without as plain rows, in one list: same row, a chevron only where there is something to fold, and selection, pin
  and cmux inside the row's own box.
- A scroll view reused for several sections (or sessions) gets an identity per content (`.id(section + key)`): it
  otherwise keeps the old offset, and a short section drew its rows over the header.

## Widget and panel controls, round 2 (Martin, 2026-10-23 15:35)
- Hover on every control, shaped like the control: a circle bubble gets a ring (`WidgetBubbleChrome`), which pulses
  once on enter and settles. Opacity only, never a repeating animation.
- A filter bar and its headline sit outside the scroll view they filter, pinned under the tabs.
- A filter change in an open panel holds the panel's height (`WidgetModel.holdAgentFit`); folding a row or switching
  view releases it. An empty filter result must not collapse the panel.
- A header line under a title is the place for facts: agent · project · model · working / idle `LiveAgo` · ctx.
- Rows: last active and newest question or answer, both `LiveAgo`.
- An alert (sound, popup, auto-expand) has a setting each, a sound per kind with a play button, and flashes the
  session that caused it for `alertFlashSeconds`.
- A hover tooltip that duplicates a hover preview is off by default ("auto"), and the preview must open reliably:
  a control the pointer reaches inside a panel starts the panel's hover itself, since the panel's own hover fires
  only on crossing its edge.
- Two views of the same sessions (the rail bubbles and the hover list) read in one order; a bubble and its row sit
  at the same place. A sticky order that never moves is an option, not the default (Martin, 2026-10-23 17:47).
- A flash reaches every place the session shows, including a list the alert itself opened: such a list is built
  after the trigger changed, so it needs the flash start time, not only the trigger.

## Feedback
- Every action answers within 100 ms: visible state change, sound for capture, progress for slow work.
- Errors say what happened and what to do, in a dialog when the user must act. A missing grant goes through
  `PermissionCenter` (GenesisKit Permissions/); test each path with `bun scripts/native/staging.ts deny <kind>`.
- Counts mean something: "99+ unread" made of weeks-old items is noise; age them out or let the user clear.
  Never print a raw total of sessions; count what needs attention. One numbering scheme per list.
- Labels: sentence case, no ALL-CAPS titles (tiny kickers excepted), no instructions to run commands that
  do not exist, no hand-edit-this-JSON advice where a control belongs.

## Real time and state
- New data appears without a reload; the view does not jump when it arrives.
- Every setting has a control, writes the key its reader reads, takes effect live and survives a restart.
- Reduce Motion and Reduce Transparency are honoured.

## Loading, swaps and diffs (Martin, 2026-10-13 17:22)
- A pending lookup never shows its negative answer ("not in a git repository", "no results"): show nothing or a
  quiet placeholder until the answer is known. Keep "loading" and "none" as different states in the model.
- Switching what a pane shows (a tab, a session) keeps the old content on screen until the new one has rendered,
  then swaps with a short transition; never a blank frame in between. One generic container, used by every host.
- The window keeps its size and place across restarts; verify with a restart, not by reading the code.
- Diffs: a whole added or removed block gets a left strip, not a background; inside a changed line, highlight only
  the changed words (and keep the strip). No full-row backgrounds that read as odd/even striping in tables.
  `+N` green and `−N` red wherever counts appear.
- Choosers with more than a few items (commits, versions) are popovers with details and search, built when opened;
  never a system menu that builds every item up front.
- Segmented tabs animate the selection pill to the new segment and show a hover fill on inactive ones
  (`GenMotion`, instant under Reduce Motion).
- A list of changes offers "reveal the open file" and shows `+/−` per file and folder where the counts are known.
- A control that sits inside a scrolling list (a pill, a "Latest" button) is not the reader's own input: it must not
  trip the list's "the reader is scrolling or clicking" guards. Test it with a real posted click, not a direct call.
- Dense rows carry no instant tooltip each; the row's own text says it, and `.help` covers a cut-off path.
- A list of hosted projects quietly leaves out what is not hosted (a clone of a local folder, no remote); an error
  banner is for a project that should work and does not.
