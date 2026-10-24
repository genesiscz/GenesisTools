# Auditing a surface from its code

Use this when you are asked to review, audit or "check" a surface, and before you call your own change shippable.
A code audit finds most of what a user meets. The live checks in [live-testing.md](live-testing.md) confirm what
depends on timing, focus or the window server.

## 0. Before you claim anything: what the shared pieces already do

Most wrong claims in past audits named a defect that a shared component already handles. Open the component before
you report that something is missing. What they do (2026-10-24):

- `.genHover()`, `.genHoverPlain()`, `.genHoverIcon()`, `.genHoverRow()` (GenesisKit `Style/GenHoverButton.swift`):
  hover fill and border, the pointing-hand cursor, a disabled look, Reduce Motion, and padding that grows the hit
  area (4 by 6 pt; `.genHoverIcon` draws a 22 pt circle). A control with one of these has hover and a hand cursor.
- `IconButton` (`Controls/IconButton.swift`): an instant tooltip and the same text as its accessibility label.
- `GenMotion` (GenesisKitBase `Style/GenMotion.swift`) and `@GenReduceMotion`: no animation under Reduce Motion.
  `GenDisclosure`, `AttentionPulse` and the hover styles go through them.
- `NoticePill` (`Controls/NoticePill.swift`): a success note fades by itself; an error stays.
- `EmptyState` (`Controls/EmptyState.swift`): takes `actionTitle` and `action`. An empty state without a button is
  the caller's choice, not a limit of the component.
- A SwiftUI `Button` reads as one VoiceOver element with its label; a row built from `.onTapGesture` does not.
- Keymaps: `HubKeymap.swift` and `WidgetKeymap.swift` hold the shortcuts. Search them before "there is no shortcut".
- Preferences: a constant may already be a setting. Search `WidgetPreferences` (GenesisKit
  `Widgets/WidgetWireModels.swift`), `src/hub/lib/widget/types.ts` and the settings pages before "not configurable".

An absence claim ("no Esc", "no undo", "never announced", "no hover") needs a search across the whole package, not
only the file in front of you: `rg -n '<what>' src/macos --type swift`. Put the command and its count in the finding.

## 1. Map the surface

Size it first. A UX audit reads every control, so keep one surface to about 5,000 lines and split a larger one by
window or pane. Measured on 2026-10-24 (Sonnet, one run each): surfaces of 2,000 to 4,500 lines found 73 to 78% of the
known defects, and the 10,800-line hub-settings surface found 52%. The same test on the swift skill was sharper: whole
areas of 39,000 and 112,000 lines found under 40%, and the same code in surfaces of 6,000 to 21,000 lines found 90%.

Then run the scanner. It runs every search recipe of the passes below in one go and prints the candidate lines
per pass, plus facts over the whole set (announcements, undo, re-read on activation, arrow keys, files that animate
and never read Reduce Motion, duplicate reload buttons):

```bash
bun <this skill's folder>/scripts/ux-scan.ts <files or folders of the surface>
# in this repo: bun .claude/skills/ux/scripts/ux-scan.ts src/macos/GenesisKit/Sources/GenesisKit/Recording
```

A line in its output is a candidate, not a finding. Open each one in context, check section 0, and keep only what
the user meets. Walk every section of the output: a section with candidates you did not open is a pass you skipped.
The scanner cannot see everything (a count that adds two kinds of thing, a verb that differs between two strings, a
failure written into a panel that closes): the questions of each pass still apply.

Before you judge anything, also list with line numbers:

- every control: `rg -n 'Button\(|Button \{|Menu|Toggle|Picker|TextField|\.onTapGesture|\.onHover' <files>`;
- every timer and delay: `rg -n 'asyncAfter|Timer\.|Task\.sleep|\.delay\(' <files>`;
- every count, badge and number the user sees, and what feeds it;
- every message the user can get: success, error, empty, loading, missing permission;
- every animation: `rg -n 'withAnimation|\.animation\(|\.transition\(|repeatForever' <files>`;
- every key handler: `rg -n 'keyboardShortcut|onKeyPress|onMoveCommand|onExitCommand|cancelAction|defaultAction' <files>`.

Then walk the passes below over that list. A large file is no excuse to skip a pass: run the recipe, then read the
hits and the code around them.

## 2. The passes

Each pass names the questions, the recipes and the checklist section that holds the rule.

### Pointer and targets ([checklist](checklist.md#affordance), [hit targets](checklist.md#hit-targets))
- Does every control from the map use a shared hover style, or draw its own hover and cursor? Bare ones:
  `.buttonStyle(.plain)`, `.buttonStyle(.borderless)`, a `Menu` without a hover style, `.onTapGesture` on a view.
- Is the hit area at least the drawn shape, and do neighbours split the gap between them? Compare `.frame`,
  `.padding` and `.contentShape` with the drawn size and the stack's spacing: a click in the gap between two bubbles
  or icons must land on one of them. Padding applied after `.buttonStyle(.plain)` sits outside the button and takes
  no clicks.
- Is any target under 22 by 22 pt (`frame(width: 1x, height: 1x)` on a button label, a 12 pt glyph with 3 pt
  padding)?
- Does a custom `ButtonStyle` read `configuration.isPressed`? Does every `.onDrop` / `.dropDestination` show
  `isTargeted`? Does an `.overlay` or ZStack layer over a control pass clicks (`allowsHitTesting(false)`)?

### Keyboard ([checklist](checklist.md#keyboard))
- Can the user walk every list with Up and Down and open the selected row with Return?
- What does Return do in each dialog, prompt and card? `.keyboardShortcut(.defaultAction)` belongs on the safe or
  reversible choice, never on Send, Delete, Approve or Discard. Check what Return does when no field has focus.
- Does Esc close every popup, sheet, card and overlay without acting? An `NSPanel` subclass needs `cancelOperation`
  or a key handler; a SwiftUI one needs `.onExitCommand` or `.onKeyPress(.escape)` on a view that has focus.
- Does a surface that opens to type (composer, search, find, prompt) focus its field on open? Recipe: files with
  `TextField(` or `TextEditor(` and no `.focused(` or `makeFirstResponder`.
- Is a focus ring removed (`focusEffectDisabled`, `focusRingType = .none`) without a focused look in its place?
- Does a bare-letter shortcut (`onKeyPress(characters:`, `keyboardShortcut("j")` with no modifiers) fire while a text
  field has focus?
- Does every control with a shortcut show it in its tooltip? Recipe: compare the keymap's bindings with
  `rg -n 'instantTooltip\("[^"]*[⌘⌥⇧⌃]'`.
- Does every search or filter field (`TextField("Search`, `"Filter`, `"Find`) have a clear button?
- Is an action reachable only from a right click? Recipe: `rg -n '\.contextMenu' <files>`, then look for the same
  action as a visible control or a key.
- When a sheet, popover or panel closes, does focus go back to the control that opened it?
- Does a multi-line composer say which key sends and which adds a line?
- Do the shortcuts work wherever focus is inside the panel, or only when the root view has focus? A handler on a
  container stops firing when a child (a field, a list) takes focus.
- Does a shortcut take a key that macOS or the app's other windows use for something else: ⌘H Hide, ⌘M Minimize,
  ⌘W Close, ⌘Q Quit, ⌘, Settings?
- Do ⌘1 to ⌘9 switch tabs and modes?

### VoiceOver ([checklist](checklist.md#voiceover))
- Does every icon-only control have a label? Does every status icon, badge and count capsule that means something
  have one? `.instantTooltip` and `.help` set no accessibility label: a meaning that lives only in a tooltip is
  lost to VoiceOver. Recipe: `rg -n 'instantTooltip' <files>` on views that are not `IconButton`, then look for a
  label beside each.
- Is a selected row, tab, filter or option exposed as selected (`.accessibilityAddTraits(.isSelected)` or a value)?
  A checkmark or a tint alone says nothing.
- Does every action that appears only on hover (`if isHovering { Button … }`) also exist as
  `.accessibilityAction(named:)` on its row or as a context-menu item?
- Is every change that happens without the user's action announced (an alert arrives, a send fails, recording
  starts or stops, a grant changes)? Recipe: `rg -n 'announcementRequested|AccessibilityNotification' src/macos`.
- Does a row made of several texts read as one element with its state (`.accessibilityElement(children: .combine)`)?
- Does VoiceOver meet the views in their visual order? A ZStack or overlay whose later child draws first needs
  `accessibilitySortPriority`.
- Do custom faint colours have an Increase Contrast variant (`colorSchemeContrast`)?
- Is a view that is faded out (`.opacity(0)`), zero-size or off screen still readable by VoiceOver? It needs
  `.accessibilityHidden(true)` while hidden.
- Does an accessibility label repeat the control type ("… button") or differ from the visible text?

### Feedback and errors ([feedback](checklist.md#feedback), [errors](checklist.md#errors-and-recovery))
- For every async action in the map: what does the user see while it runs, when it works and when it fails?
- If the view that started it is gone when it fails (a panel collapsed, a popover closed), does the failure come
  back to the user (the trigger flashes, a popup offers Retry, a notification)? A result written into a closed panel
  is lost.
- Does each note have the right life: success fades after a few seconds, an error stays until it is closed? A note
  with no timer stays forever; an error with a timer is gone before it is read.
- Where does a failure show: on the row or card that failed, or does it blank the whole pane (a `Text(error)` in
  place of the list)? Does each cause (not installed, no receiver, refused, offline, timed out) get its own text and
  next step? Does a failed send keep the typed text and the staged items?
- Does a bulk action (send all, clear all, import) end with how many worked and how many failed?
- Raw error text on screen: `rg -n 'Text\([^)]*(error|Error|detail|stderr|reason)' <files>` and
  `rg -n 'localizedDescription|stderr|suffix\(6' <files>`; each hit that reaches a label shows the machine's words.
- Does the view build formatters or sort lists while it draws (`DateFormatter()`, `ISO8601DateFormatter()`,
  `NumberFormatter()`, `.sorted(` in a computed property the body reads)? The user meets a hitch on every redraw;
  the swift skill has the fix.
- Is the error text one sentence of what happened and what to do, with Retry where it makes sense and raw output
  only behind Details? Raw stderr or `localizedDescription` alone is a defect.
- Is the tone (success, warning, error) stored with the message? Code that picks the colour from words in the text
  is a defect.
- Does a wait that blocks the user's agent (an approval, a question) escalate: a sound, then a notification?
- Does a spinner or skeleton appear for work that ends in under 200 ms (a `ProgressView(` or `Skeleton` shown at
  once, with no delay)? Does the placeholder have the size of the content that replaces it?
- Does anything the user waits on end in an error or a Cancel within about 10 s? Recipe: timeouts and default
  `timeoutSeconds` above 10 on calls a view waits for.
- Is a success announced with a modal alert (`NSAlert`, `.alert`) instead of a note?
- Does the first frame show a default that `onAppear` or `.task` then replaces with the saved value?
- Does every loading state end, in content, an empty state or an error? A skeleton or spinner that stays forever
  after a failed read is a defect. Does a transient state ("Copied", "Saved", "Sending…") revert?
- Does a control show that it is busy while its action runs, and refuse a second press? Does a disabled control say
  why it is disabled (a tooltip or a caption)? A greyed control with no reason is a dead end.
- Does a primary action of a pane (Send, Apply, Save) have a shortcut, shown on the button or in its tooltip?

### Destructive actions and undo ([checklist](checklist.md#undo-and-destructive-actions))
- For every Dismiss, Discard, Delete, Remove and Clear: can the user undo it (Undo in the note, ⌘Z), or must they
  confirm it? Undo beats a confirmation for frequent actions.
- Is the safe choice the default button? A destructive choice is marked as such and never sits on Return.
- Does a confirmation on a frequent action offer "Do not ask again" (`showsSuppressionButton`)?
- Does a sheet with Cancel bind its fields straight to the store (so Cancel cannot undo), instead of a draft?
- Does text the user typed survive a dismissal (a popover closed by an outside click, a panel that collapses, a row
  that scrolls away)? Does anything the user staged (an image, a draft) survive a lazy row's `onDisappear`?

### Empty, loading and denied ([checklist](checklist.md#empty-and-loading-states))
- What does every list and pane show when it is empty? It says why, and offers the next step as a button, never as
  a command to type in a terminal.
- Are "loading", "none yet", "filtered out", "permission missing" and "failed to load" different states with
  different text? An empty result behind a missing grant names the grant and opens its settings pane.

### Motion ([checklist](checklist.md#motion-and-reduce-motion), [motion.md](motion.md))
- Under Reduce Motion, does any animation still move or scale? Fades are allowed; travel, scale, bounce and loops
  are not. Safe paths: `GenMotion`, the shared styles, a check of `@GenReduceMotion` or `accessibilityReduceMotion`.
- Recipes: `rg -n 'reduceMotion: false'` (a hard-coded false); `withAnimation(.` and `.animation(.` with a literal
  curve; `repeatForever`; `.transition(.move` and `.transition(.scale`. Read each hit for a Reduce Motion check.
- Files list: `rg -l 'withAnimation\(|\.animation\(|repeatForever|CABasicAnimation|NSAnimationContext|animator\(\)'`
  minus `rg -l '(?i)reduceMotion|GenMotion|ShouldReduceMotion'`. Every file left animates with no check at all;
  AppKit window moves and Core Animation count too.
- Is Reduce Motion read once into a `static let`? Does a timer wait for an animation (`asyncAfter` of about the
  animation's duration)? Does anything scale in from 0? Does a loop stop when its view is hidden?
- Is a spring or a bounce used for a routine change, instead of `GenMotion` or a named curve?

### Things that appear by themselves ([checklist](checklist.md#attention-and-notifications))
- Can every popup, HUD, flash and sound that starts without the user be closed without acting (×, Esc)? Does it
  name its cause? Are its duration, sound and placement settings ([opinionated-settings](../../../rules/opinionated-settings.md))?
- Recipe: `rg -n 'asyncAfter\(deadline: \.now\(\) \+ [0-9]'` and `Timer` intervals in view and model code. A duration
  the user notices, written as a literal, is a missing setting.
- Does a system notification fire for a session the user is already looking at, or twice for one item? Does every
  alert open what it is about? Does a burst of alerts give one cue or one per alert?

### Counts, words and text ([checklist](checklist.md#counts-words-and-text))
- For every count: what exactly does it count? Does it match the same count on the other surfaces (a tab title, the
  hub)? Does it count only what needs the user, or does it add things of another kind?
- Is one thing called by one word across the widget, the hub and settings? Do option badges and the keys that pick
  them use the same symbols?
- Raw data shown as words: a string from the data (a state, a kind, an id, a source name, an error detail)
  interpolated into a label or tooltip (`"CI: \(state)"`, `status.capitalized`, a raw session id as a fallback
  title). Map each value to a sentence, or hide it. Recipe: `rg -n 'Text\([^)]*\\\(' <files>` and
  `rg -n 'instantTooltip\("[^"]*\\\(' <files>`, then ask what each interpolated value looks like to the user.
- Tooltips and captions say what happens, not which command runs (`tools …`). Does a tooltip hold something the
  user needs to finish the task?
- Em and en dashes in visible strings: `rg -n '"[^"]*[—–][^"]*"' <files>` (Swift string literals only).
- Buttons named OK, Yes or No: `rg -n 'Button\("(OK|Yes|No)"'`.
- State colours: `rg -n 'Color\.(red|green|orange|yellow|blue)\b|\.foregroundStyle\(\.(red|green|orange)\)'` next to
  the palette (`KitPalette`, `ReviewPalette`); a raw system hue for a state that the palette already names is a
  mismatch between surfaces.
- ALL-CAPS titles: `rg -n 'Text\("[A-Z][A-Z :]{5,}"\)'` and `.textCase(.uppercase)`. Tiny kickers are the exception.
- Small, faint text: `rg -n 'size: (8|9|9\.5|10)[,)]'` near `.opacity(0.3)` to `.opacity(0.5)`. Text the user must
  read keeps 4.5:1 contrast against its real background.

### Layout ([checklist](checklist.md#layout))
- Text inside a fixed frame (`.frame(height:)`, `.frame(width:)`) with no `.lineLimit` and no truncation: a long
  value wraps or clips. Labels that embed a title or a path are the usual case.
- Two controls on screen at once that do the same thing (two reload buttons, a toggle in a popover and in settings
  with other words). One navigation per surface.
- The same control drawn two ways in one app (a native `Picker(.segmented)` where the kit has `GenSegmentedTabs`).

### Windows and settings ([windows](checklist.md#windows-and-overlays-martin-2026-10-14), [settings](checklist.md#settings))
- Is state that can change outside the app (a privacy grant, a login, a file) read again when the app becomes
  active (`NSApplication.didBecomeActiveNotification`) or the window becomes key?
- Can the user find every setting (a search field once there are more than a few pages)? Does each setting live in
  one place, with one name and one range?
- Is a sub-option live while its parent switch is off (a `Toggle` followed by controls with no `.disabled(!…)`)? Does
  a settings file push pages (`NavigationLink`, `NavigationStack`)?
- Windows: a resizable window without a minimum size; placement by `NSScreen.main`; `runModal()` without
  `preventsApplicationTerminationWhenModal = false`; a popover that holds a `TextEditor` or a send button;
  `setActivationPolicy` outside `DockTile`; an `NSPanel` that hides on deactivate or uses a shielding level.

## 3. Report

One block per finding:

- **Where:** path:line.
- **What the user meets:** the experience in one or two sentences, not the code.
- **Rule:** the checklist section or SKILL.md line.
- **Evidence:** the code line, quoted; for an absence, the search and its count.
- **Fix:** one sentence.

Order by harm: lost work, a blocked task and keyboard or VoiceOver exclusion first; confusion and waits next; polish
last. Before you write a finding, check section 0 again: if a shared component already covers it, drop it. One
wrong claim costs more trust than one missed defect.

Leave out matters of taste and anything the user would not notice. Every finding names the checklist rule it
breaks; a finding with no rule is an opinion. A slot spent on taste is a slot a real defect does not get.

End the report with **Coverage**: one line per pass, with the searches you ran, their hit counts, and the findings
it produced or "none". A pass with no line was skipped, and a skipped pass is where the misses come from. When the
finding limit forces a cut, cut polish, never a whole pass.
