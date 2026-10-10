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

## Layout
- Equal, intentional insets on all four sides; controls aligned in one column; descriptions under titles.
- Panels size to their content up to a maximum; no large empty band above a composer.
- Nothing is cut off: overflowing content scrolls with an edge cue (`.scrollOverflowContent()` +
  `.scrollOverflowHints()`); `.scrollIndicators(.visible)` does not keep overlay scrollers visible. The last row
  and badges are fully visible at the smallest window size.
- Segmented tabs in a non-activating panel: the native `Picker` greys its selection out of the key window; use
  `GenSegmentedTabs`.
- One navigation per surface; no two controls that do the same thing side by side.
- Distinct icons for distinct features (two modules once shared `waveform`).

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
