# Where the rules came from (distilled 2026-10-24)

On 2026-10-24 about 110 agent skills about UX, macOS design, motion, feedback, tooltips and accessibility were
downloaded and read as data (never installed, never run). Their rules were merged (942 extracted, 226 after merging),
judged against this skill, and the gaps were added to [checklist.md](checklist.md) and [audit.md](audit.md). A rule
was rejected when it conflicts with a repo rule (`.claude/rules/opinionated-settings.md`, `.claude/rules/macos-app.md`),
when it is web-only or iOS-only, or when the skills contradict each other without evidence. The research notes, with
every quote, its file and line, and the hit counts in `src/macos`, are in the notes vault under
`GenesisTools/2026-10-24-UxSkillChanges/` (`Research-UxSkillGaps-MacOSMotion`, `Research-UxSkillGaps-FeedbackA11y`,
and the four `Research-Rules*` notes).

## The skills that gave most rules

Counted as the strongest source of a gap or partial rule in the two gap notes.

- **educlopez/ui-craft** (ui-craft, dense dashboard): feedback on press, failures on the row that failed, focus
  return, disabled reasons, empty states, density.
- **seansmithworks/impeccable-swift**: Swift-specific states (busy, disabled, empty), spinners, wording, motion.
- **ehmo/platform-design-skills@macos**: numbered macOS rules for keyboard (Esc, Return, every mouse action by key),
  alerts, popovers, windows, VoiceOver order, Increase Contrast, hit sizes.
- **rgmez/apple-accessibility-skills@appkit-accessibility-auditor**: announcements, accessibility actions for
  hover-only controls, labels, roles and values.
- **wondelai/skills** (ux-heuristics, microinteractions, refactoring-ui, steve-jobs-design-review): error text,
  note timing and escalation, contrast, one primary action.
- **AThevon/genjutsu** (desktop-principles, swiftui-motion): hover timing, target size, bare-letter shortcuts,
  scale from 0, drags that swallow taps.
- **dembrandt/dembrandt-skills** (operational-expert-tool-ui, information-architecture, notifications-and-recovery,
  loading-states, coordinated-data-views, status-colors-and-errors, ui-density): one word per concept, one name per
  place, state colours, recovery, loading.
- **yetone/native-feel-skill**: pressed states, waits that end within 10 s, hover that does not steal the keyboard.
- **charleswiltgen/axiom@axiom-macos**: sibling overlays that swallow clicks, key view loops, selection in non-key
  windows, modals that block quit.
- **aviralj02/interface-skills@reduced-motion**, **owl-listener/inclusive-design-skills** (motion-sensitivity,
  feedback-and-status): Reduce Motion replacements, flash limits.
- Tooltips: **uxcel-lab/product-skills** (ux-tooltips, notifications-and-toasts),
  **thedaviddias/ux-patterns-for-developers@tooltip**, **dragoon0x/everything-design-taste@tooltip-popover-patterns**.
- Smaller sources: tartinerlabs/skills@ux-psychology, chirpyworks/decision-ui, ceorkm/macos-design-skill,
  Dimillian/skills (swiftui-ui-patterns), macos-patterns, mastepanoski/claude-skills@ui-design-review,
  rhyssullivan/skills@no-ui-flash, millionco/skills@interactive-hit-areas, gbasin/dejank, mxvsh/skills@macos-swiftui,
  aladicf/better-web-ui@empty-state, rshankras/claude-code-apple-skills@settings-screen,
  fayazara/macos-app-skills@settings-ui.

## Conflicts and how this skill settles them

- Hover scale: some skills forbid any scale, others allow up to 1.05. Here: a layout-neutral scale is allowed (the
  shared hover styles use 1.04 and 0.97 pressed).
- Spinner delay: 200 ms, 300 ms or 300 to 500 ms. Here: no spinner under about 200 ms.
- Reduce Motion and spinners: a progress indicator keeps running; decorative loops stop.
- Hover reveal: some skills forbid it. Here: allowed, because the app builds hover previews and row-only controls on
  purpose, as long as every hover-only action also has a keyboard and VoiceOver route.
- "Prefer a default over a setting" (steve-jobs-design-review): rejected; the repo rule is that an opinionated
  behaviour ships as a setting. Fewer switches come from folding per-event toggles into one choice.
- Tooltip delay of one second: rejected; the app's instant tooltips are a deliberate choice.

## Not used

- uwussimo/ux-laws: never installed or run. Its installer overwrites itself, runs `rm -f`, and stars a repository on
  the user's account.
- Web-only rules (CSS, ARIA, Web Audio numbers) and iOS touch sizes (44 pt).
