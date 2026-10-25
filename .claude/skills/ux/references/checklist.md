# Shippable checklist for a native view

Walk it for every view you change. Each line exists because it was missed at least once, or because one of the
skills distilled on 2026-10-24 states it and the app broke it ([sources.md](sources.md)). [audit.md](audit.md) says
how to find a violation in code.

Sections: [Affordance](#affordance) · [Windows and overlays](#windows-and-overlays-martin-2026-10-14) ·
[Layout](#layout) · [Widget and panel controls](#widget-and-panel-controls-martin-2026-10-23-1440) ·
[Hit targets](#hit-targets) · [Keyboard](#keyboard) · [VoiceOver](#voiceover) · [Feedback](#feedback) ·
[Errors and recovery](#errors-and-recovery) · [Undo and destructive actions](#undo-and-destructive-actions) ·
[Empty and loading states](#empty-and-loading-states) · [Motion and Reduce Motion](#motion-and-reduce-motion) ·
[Attention and notifications](#attention-and-notifications) · [Counts, words and text](#counts-words-and-text) ·
[Settings](#settings) · [Real time and state](#real-time-and-state) ·
[Loading, swaps and diffs](#loading-swaps-and-diffs-martin-2026-10-13-1722)

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
- A custom button style draws a pressed state that differs from its hover state (`configuration.isPressed`).
- A drop target highlights (an accent outline or fill) while a drag is over it (`isTargeted`).
- Rest, hover and pressed keep the same size, padding and font weight; hover changes only opacity, fill, a ring or
  a layout-neutral scale. A hover reacts to enter and exit, never to every pointer move, and clears on exit.
- A click acts on mouse-up, so a press dragged off the control cancels it. No busy cursor as a loading cue: the
  element that waits shows it.
- Every context-menu action also has a visible control or a key: a right click is never the only way.
- Status and essential data show inline, not only on hover; what a hover preview shows is also reachable by click
  or keyboard.
- An overlay, scrim or note layer that is not a control passes clicks through (`.allowsHitTesting(false)`), unless
  it blocks on purpose. A `DragGesture(minimumDistance: 0)` on a container swallows the taps of its buttons.
- 🛑 A render is not a click. After any change to a clickable view, press it once in the REAL installed app
  (`tools control click --app <app> --desc <label>`, which does not take focus) and read the app's own action log
  (`command log show --predicate 'subsystem == "genesiskit" AND category == "markdown.input"' --last 1m`). A PNG
  proved the tab groups looked right while one press on a group chip had made the whole window deaf (2026-10-23).
- Press each NEW kind of control at least once (a chip, a menu, a drop target), not only the old ones beside it.

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
- A resizable window has a minimum size that keeps its UI usable.
- A floating panel is non-activating, does not hide when the app deactivates, becomes key only when it takes text,
  and never uses a shielding window level.
- Place a window by the pointer's screen, the window's own screen or the saved display, never by `NSScreen.main`
  alone.
- A modal that does not need an answer does not block quitting or an update (`preventsApplicationTerminationWhenModal
  = false`).
- A popover holds a short option or a detail; a reply, a form or a multi-step flow gets a panel, a sheet or inline UI.
- A window opened by the app goes through `DockTile.policy(for:)` for its activation policy, so it comes to the front
  and keeps the Dock icon while it is open.
- In a regular window, a selection takes the inactive look when the window is not key. A non-activating panel (the
  widget) keeps its look, since it is never key by design.
- State that can change outside the app (a privacy grant, a login, a file) is read again when the app becomes active
  or the window becomes key.

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
- One navigation per surface; no two controls that do the same thing side by side, and no two reload buttons on
  screen at once.
- Text in a fixed frame has a line limit and truncates; a label that embeds a title or a path otherwise wraps or
  clips at real lengths.
- One control is drawn one way across the app: the kit's version, not a native one beside it.
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

## Hit targets
- A clickable control is at least 22 by 22 pt including its padding; a smaller one states why in a comment.
- The hit area is at least the drawn shape. A small glyph gets the padding of a shared hover style (`.genHoverIcon`
  is a 22 pt circle); a row that acts takes clicks over its whole width and height (`.contentShape(Rectangle())`).
- Neighbours split the gap between them. A strip between two bubbles or two icons where a click does nothing is a
  dead zone: grow each target into half the gap, or move the spacing inside the targets.

## Keyboard
- Every list: Up and Down move the selection, Return opens it, Esc clears or closes. A list the user can only click
  is a defect, in a panel as much as in a window.
- Return picks the safe choice. In a dialog, a prompt or a card, the default button keeps the user's work (Keep,
  Cancel, Not now); Send, Delete, Approve and Discard are never on Return. Check what Return does when no field has
  focus.
- Esc closes every popup, sheet, card and overlay without acting, cancels an operation that is running, and in an
  edited text field puts the previous value back.
- Every action the mouse can start, the keyboard can start too. A view that acts only through `.onTapGesture` needs
  a Button or a key handler beside it.
- A surface that opens to be typed in (a composer, a search, a find bar, a prompt) focuses its field when it opens,
  without waiting for its animation to end.
- A control that takes keyboard focus shows a focus ring or a visible focused look; never remove the ring without
  one.
- A shortcut without a modifier (a bare letter or digit) never fires while a text field has focus, and the user can
  turn single-letter shortcuts off; a new shortcut prefers a modifier.
- When a sheet, popover or panel closes, focus returns to the control that opened it; after a delete it moves to a
  neighbour, never to nothing.
- A multi-line composer says which key sends (Return or ⌘Return) and which adds a line (⇧Return), in a hint beside
  the field.
- A control with a shortcut shows it in its tooltip ("Send (⌘↩)"); where the app has a menu bar, the shortcut is
  also a menu item.
- A search or filter field shows a clear button while it holds text, and Esc clears it.
- Shortcuts work wherever focus is inside the window or panel, not only when the root view has focus.
- A key that macOS defines keeps its meaning: ⌘H Hide, ⌘M Minimize, ⌘W Close, ⌘Q Quit, ⌘, Settings. One meaning per
  shortcut across all windows of the app.
- ⌘1 to ⌘9 switch tabs and modes, in their visible order.
- Hover never moves the keyboard selection. The pointer's highlight and the keyboard's selection are two states.

## VoiceOver
- Every icon-only control has a label (`IconButton` gives one); a decorative image is hidden.
- A status icon, badge or count that means something has a label too. `.instantTooltip` and `.help` set none: a
  meaning that lives only in a tooltip does not reach VoiceOver.
- A selected row, tab, filter or option says so (`.accessibilityAddTraits(.isSelected)` or a value), not only by a
  checkmark or a tint.
- An action that appears only on hover is also an `.accessibilityAction(named:)` on its row, or a context-menu item.
- A change that happens without the user's action is announced: an alert arrives, a send fails, recording starts or
  stops, a grant changes (`AccessibilityNotification.Announcement`, or
  `NSAccessibility.post(element:notification: .announcementRequested, userInfo:)` in AppKit).
- A row made of several texts reads as one element with its state (`.accessibilityElement(children: .combine)`).
- Colour is never the only signal: a state shown in colour also has a symbol or a word, and the view reads
  `accessibilityDifferentiateWithoutColor` where it can add one.
- The accessibility label matches the visible text and leaves out the control type ("Send", not "Send button").
- A control drawn from shapes or gestures has a role, a value and an action (`accessibilityAddTraits`,
  `accessibilityValue`, `accessibilityAction`).
- A view that faded out, has zero size or sits off screen is hidden from VoiceOver, and an exiting view ignores
  clicks.
- Translucency comes from system materials, not `Color.opacity` plus a blur, which ignores Reduce Transparency.
- A report of an accessibility change names the manual checks that ran: VoiceOver, Full Keyboard Access, the
  Accessibility Inspector. A code audit alone proves little.
- VoiceOver reads in the visual order. Where a layout draws a later view first (a pinned header, a composer above
  its list), fix the order with `accessibilitySortPriority` or grouping.
- Custom colours have a stronger variant under Increase Contrast (`@Environment(\.colorSchemeContrast)`), above all
  faint text and hairlines.

## Feedback
- Every action answers within 100 ms: visible state change, sound for capture, progress for slow work.
- No spinner or skeleton for work under about 200 ms; after that, one spinner per section; a skeleton only for loads
  over about 500 ms. A placeholder has the size of what replaces it, so nothing moves when the data arrives.
- Anything the user waits on shows an error, a reason or a Cancel within about 10 s, not at a 30 s or 120 s process
  timeout.
- A success note fades after a few seconds (the hub's `NoticePill` is the model): at least 2 s, about 1 s plus 50 ms
  per word. A new note replaces the old one. An error stays until it is closed.
- A success never gets a modal alert; a modal is for a decision or a failure the user must act on.
- The first frame of a window or panel uses the saved setting (size, look, tab), never a default that snaps to the
  saved one.
- The result of an action reaches the user where they are. When the view that started it is gone (a panel collapsed,
  a popover closed), a failure flashes the trigger and offers Retry, or posts a notification.
- A wait that blocks the user's agent (an approval, a decision) escalates: a sound when it arrives, a notification
  after a delay that is a setting.
- Every loading state ends in content, an empty state or an error; a skeleton after a failed read stays forever.
  A transient state ("Copied", "Saved") reverts by itself.
- On press, a control flips its own state in the same frame: disabled, label kept, width stable, a spinner inside,
  so a second press cannot start the action twice. A disabled control says why (a tooltip or a caption); a greyed
  control with no reason is a dead end.
- A bulk action ends with a result: how many worked, how many failed and which. It never completes silently.
- Say what is loading ("Reading the session"), not the bare word Loading. Past 5 to 10 s show progress and a Cancel;
  a longer job runs in the background and reports when it ends.
- Stale, partial or disconnected data looks different from live data and says when it was last updated.
- The primary action of a pane (Send, Apply, Save) has a shortcut, and the button or its tooltip shows it.

## Errors and recovery
- Errors say what happened and what to do, in one sentence, with Retry where a retry can work, in a dialog when the
  user must act. Raw output (stderr, a stack, `localizedDescription`) goes behind a Details disclosure.
- The tone (success, warning, error) is stored with the message by the code that knows it. Picking a colour from
  words in the text is a defect: one message without the word shows a failure in green.
- A failure shows on the row, card or section that failed. It does not blank the pane, and a recoverable error never
  raises a modal.
- Each cause has its own text and its own next step: not installed, no receiver, refused, offline, timed out. One
  generic "failed" for all of them is a defect.
- A failed send keeps what the user wrote: the typed reply, the staged answers, the filters. Clear the input only
  after the receiver confirms.
- A failure is the app's problem, not the user's: no blame, no "you must", no "Something went wrong".
- A missing grant goes through `PermissionCenter` (GenesisKit Permissions/); test each path with
  `bun scripts/native/staging.ts deny <kind>`.

## Undo and destructive actions
- A frequent destructive action (dismiss, discard, remove, clear) gets Undo: a note with an Undo button for a few
  seconds, and ⌘Z. Undo beats a confirmation for things done many times a day.
- A rare, large one (delete a project, forget a key) asks first; its button is marked destructive and is not the
  default. It names the action and the object, with the count when it removes several ("Delete 3 drafts"), never
  OK, Yes or No.
- Every sheet, alert and multi-step flow has a visible Cancel besides Esc.
- A routine destructive action is a quiet secondary button, kept apart from the common action; each card, dialog or
  sheet has one primary action.
- A confirmation the user meets many times offers "Do not ask again", which persists and can be undone in settings.
- A sheet or panel with Cancel edits a draft: it writes on commit and restores on Cancel.
- Text the user typed survives a dismissal: a popover closed by an outside click, a panel that collapses, a row that
  scrolls away. Something the user staged (an image, a draft) is never dropped in a lazy row's `onDisappear`.

## Empty and loading states
- An empty pane says why it is empty and offers the next step as a button (`EmptyState(actionTitle:action:)`).
  Never tell the user to run a command where a button can do it.
- Loading, none yet, filtered out, permission missing and failed are different states with different text. Empty
  data behind a missing grant names the grant and opens its settings pane.
- An empty pane hides the filters, sort and tabs that would do nothing.
- A first run offers one suggested action, not a tour, and asks for a permission when it is first needed, not at
  launch.

## Motion and Reduce Motion
- Every animation honours Reduce Motion: fades stay, travel, scale, bounce and loops go. Use `GenMotion`, the shared
  styles or `@GenReduceMotion`; never pass a literal `false` where a component asks for the Reduce Motion state.
- That includes AppKit and Core Animation: `NSAnimationContext`, `animator()`, `CABasicAnimation` and hand-made
  timers that move a window read `NSWorkspace.shared.accessibilityDisplayShouldReduceMotion`.
- Under Reduce Motion, travel and scale become an instant change or a crossfade of 200 ms at most.
- Read Reduce Motion when you animate, never once into a `static let`; test it by switching it in System Settings
  while the app runs.
- Nothing waits on motion: a timer or a state change never assumes an animation ran or finished. When the motion is
  skipped, the flow still completes.
- Routine changes use `GenMotion` or another named curve: ease-out or a critically damped spring, no linear, no
  ease-in, no bounce on a functional control; a spring with overshoot is for a drag release or a one-shot moment.
  Hover and press take about 100 to 150 ms, other transitions 150 to 250 ms, an exit about 75% of its entrance.
- Animate opacity and transforms, not frame, padding or spacing. Do not animate frequent or keyboard-driven actions,
  or anything in settings: there, speed is the feature.
- An animation yields to new input; chain steps with the completion of `withAnimation`, not a delay. Never use the
  old `.animation(_:)` modifier without a `value:`.
- Nothing scales in from 0: start at 0.9 to 0.95 with a fade.
- A decorative loop (shimmer, pulse, breathing dot) stops when its view is hidden or idle, and goes still under
  Reduce Motion. A progress indicator keeps running under Reduce Motion: it carries meaning.
- An attention flash lasts 1 to 2 s and blinks at most 3 times a second; a burst of alerts gives one cue, not one
  per alert.

## Attention and notifications
- Anything that appears by itself (a popup, a HUD, a flash, a sound) can be closed without acting (× and Esc), says
  what caused it, and has its duration and its sound as settings.
- A notification is for something the user must act on, never for progress. No system notification for a session
  the user is looking at; never two for one unread item; group related ones.
- Every alert opens what it is about (its session, its composer) or says why it has no next action.
- A note's timer pauses while the pointer or focus is on it; a note never steals focus and has at most one action.
- Each alert kind has its own short sound (under 1 s), quiet by default; no sound for frequent or hover events. A
  master mute and quiet hours sit beside at most three category switches, not one switch per event.

## Counts, words and text
- Counts mean something: "99+ unread" made of weeks-old items is noise; age them out or let the user clear. A badge
  counts one kind of thing, the kind that needs the user, and reads the same as the same count on other surfaces.
  Never print a raw total of sessions. One numbering scheme per list.
- One word per concept on every surface: the row, the button, the settings card and the error say the same word.
- Option badges and the keys that pick them use the same symbols.
- Values from the data (a state, a kind, an id, a source, an error detail) are mapped to words before they reach a
  label or a tooltip; "CI: success" or a raw session id as a title is the data talking, not the app.
- A tooltip or caption says what happens, not which command runs. It is one or two short sentences, never repeats
  the visible label, and never holds something the user needs to finish the task.
- Truncated text shows its full text on hover; an error is never truncated.
- A button names its action in one to three words and keeps the verb through the flow; never OK, Yes or No.
- No em dash or en dash in a visible string: use a period, a comma, a colon or parentheses.
- An icon only where a standard glyph exists, in one symbol style and weight; an icon on every row is noise.
- Each state has one colour from one palette, the same on the rail, the inbox and the hub. Colour means state, never
  identity. Numbers that change in place use `.monospacedDigit()`.
- Labels: sentence case, no ALL-CAPS titles (tiny kickers excepted), no instructions to run commands that
  do not exist, no hand-edit-this-JSON advice where a control belongs.
- Text the user must read is at least 11 pt and keeps 4.5:1 contrast against its real background. Faint 9 pt text
  (white at 40 to 50% on a dark fill) fails both.

## Settings
- Every setting can be found: a search field once the window has more than a few pages.
- One setting, one place, one name and one range. A quick control elsewhere (a popover) writes the same key with the
  same words and the same choices.
- A sub-option is disabled (or hidden) while its parent switch is off or the permission it needs is missing, and
  says which.
- Settings pages are flat: a sidebar or tabs with sections, no push navigation.
- A group holds about seven rows and a page a handful of groups; per-event toggles fold into one choice.
- A text field commits on Return and on focus loss, and validates on commit, not on every keystroke.

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
- A list of changes shows a file moved outside git (a folder moved by hand) as ONE rename, "old → new", in every view
  that lists changes (the sidebar, the hub review, the status bar's "Moved from"), never as a deletion plus a new file.
- "Last update" is one newest-first list across tracked edits and untracked files. Split sections each sorted on their
  own hid every new note under a five-hour-old edit (Martin, 2026-10-25).
- A long list of changes or files (long enough to scroll) with more than one section lets the user fold each
  section: a chevron on the heading, the outline keys (Left on a file keys its heading, Left folds an open heading,
  Right opens a folded one, Return toggles), Expanded/Collapsed for VoiceOver, and the fold survives a restart.
- A panel that follows the open tab keeps its last useful content when the new tab has none (a file outside any
  repository), instead of replacing it with "not in a git repository".
- A list of hosted projects quietly leaves out what is not hosted (a clone of a local folder, no remote); an error
  banner is for a project that should work and does not.
