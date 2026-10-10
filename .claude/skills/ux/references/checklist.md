# Shippable checklist for a native view

Walk it for every view you change. Each line exists because it was missed at least once.

## Affordance
- Every clickable thing shows the pointer cursor on hover and has a hover state.
- The whole row toggles a disclosure: text, icon and chevron, not the chevron alone.
- Icon-only buttons have an instant tooltip and an accessibility label.
- Media shows a real preview (image thumbnail, video poster with duration). An icon is only for a failed
  load, and then it says what failed and offers a retry.
- Items that can be acted on can be acted on in place: tick a task, expand an answer, create a new one.
  Opening another window is the exception, not the default.

## Layout
- Equal, intentional insets on all four sides; controls aligned in one column; descriptions under titles.
- Panels size to their content up to a maximum; no large empty band above a composer.
- Nothing is cut off: overflowing content scrolls with a visible scroller or an edge fade; the last row
  and badges are fully visible at the smallest window size.
- One navigation per surface; no two controls that do the same thing side by side.
- Distinct icons for distinct features (two modules once shared `waveform`).

## Feedback
- Every action answers within 100 ms: visible state change, sound for capture, progress for slow work.
- Errors say what happened and what to do, in a dialog when the user must act (permissions always).
- Counts mean something: "99+ unread" made of weeks-old items is noise; age them out or let the user clear.
- Labels: sentence case, no ALL-CAPS titles (tiny kickers excepted), no instructions to run commands that
  do not exist, no hand-edit-this-JSON advice where a control belongs.

## Real time and state
- New data appears without a reload; the view does not jump when it arrives.
- Every setting has a control, writes the key its reader reads, takes effect live and survives a restart.
- Reduce Motion and Reduce Transparency are honoured.
