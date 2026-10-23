---
paths:
  - "src/macos/**/*.swift"
  - "**/*.tsx"
  - "src/*/ui/**"
  - "src/dashboard/**"
  - "src/dev-dashboard/**"
  - "src/hub/lib/widget/**"
  - "src/notify/**"
---

# Opinionated behavior gets a setting

Loaded by Claude Code when you read, write or edit native or web UI code, the widget's wire schema, or notifications.

Martin's rule (2026-10-23): when a UI change picks one way where a reasonable user could want another, the choice
is a setting with that way as its default. You decide the default and ship the setting in the same change; do not
ask first, and do not ship the behavior hard-coded.

## Opinionated means

- **Interruptions**: a sound, which sound per kind of event, a popup, a panel that opens or expands by itself, a
  notification, a focus steal.
- **Attention cues**: a flash, a pulse, a badge, their length and their colour; "flash the thing that caused it" is
  the expected default, and its duration is the setting.
- **Placement and order**: where a composer or toolbar sits (top or bottom), list order, which filter a list opens
  with, what a list shows (only what needs you, or everything active).
- **Hover behavior**: a tooltip or a preview on hover, hover delays, whether hover opens anything at all.
- **Timings**: auto-collapse delays, how long a popup stays.

Not opinionated: a bug fix, a layout that was wrong, a missing hover effect, accessibility labels, performance.
Those are fixed, not made optional.

## How

- One preference per choice, stored where its surface already stores preferences (the widget: the zod schema in
  `src/hub/lib/widget/types.ts` plus `WidgetPreferences` in GenesisKit `WidgetWireModels.swift`; a native window:
  its settings store). An enum over a boolean when a third way is plausible ("auto" | "always" | "never").
- The control goes on the settings page of that surface, in the card the behavior belongs to, with a one-line detail
  that says what it does. A sound picker has a play button. A list that has a filter in place gets a settings
  shortcut that opens the page at its card (`<page>#<anchor>`, `.nativeSettingsAnchor`), which flashes the card's border.
- The default is your best judgment of what Martin asked for; the option you did not pick stays reachable.
- A shared component's look change keeps the old look as a named option (the `AttentionPulse` presets: the border
  flash is the default, the filled flash stays as `.filledFlash`).
- Say in the reply which settings you added and their defaults.
