# macOS control/capture unification — Decisions

## Summary

`tools ax` (native AX automation) and the screen-capture skill's `capture-with-actions.ts` (peekaboo recording + timed actions) merge into ONE umbrella tool `tools control` (alias `tools macos control`) with one plan schema, one preflight, and the skill content consolidated into `plugins/genesis-tools/skills/macos-control/`. GenesisTools is the source of truth; `~/.claude`/`~/.agents` consume it.

## Decisions

| # | Decision | Call | Why |
|---|----------|------|-----|
| 1 | Topology | **C — unified umbrella `tools control`**; no `ax`/`capture` aliases kept | User: "capture will have all of ax plus more"; one namespace to teach; aliases explicitly waived |
| 2 | Plan schema | **One schema**: steps with optional `atMs` (timeline) or none (sequential); optional `capture{}` block → records video around execution | Realizes "atMs for both"; wait-for/assert land once, work everywhere |
| 3 | Preflight | **Merged, in Swift** — screens (NSScreen), frontmost (NSWorkspace), browser tab (NSAppleScript), windows, AX inventory, units reminder, suggested plan | Script's geometry parts all port natively; one run-this-first command |
| 4 | Preflight output | Full by default (~1.2-1.4k tokens measured); elements truncated ~15/role with counts + mandatory "re-run with `--wanted <groups>`" note; `--wanted elements:<role>,windows,screens,browser` for selective/full | Measured: ax Genesis 3.9KB, Brave 760B, script 1.7KB compact — cheap; only element inventory can blow up (2000-el cap ≈ 50k tokens) |
| 5 | JSON output | Compact by default, `--pretty` opt-in | Pretty wastes 42% (2952→1725B measured) |
| 6 | Branch/commits | `feat/macos-control` stacked on feat/fixes tip; originals committed verbatim BEFORE any fixes | Audit trail; user instruction |
| 7 | Expansions | ALL in v1 (last step, not roadmap): wait-for + assert steps, scroll + scroll-to, record-plan, annotated screenshot + Vision OCR, set/type hard-verify | User vote |
| 8 | record-plan | `record-plan --record=commands\|activity\|all` — commands: log subsequent tools-control invocations → plan.json; activity: CGEventTap + AXUIElementCopyElementAtPosition → element-targeted steps; all: merged by timestamp | User feature request |
| 9 | Skill | Modify (not rewrite) macos-control SKILL.md; capture teachings as `references/capture.md`; vitrinka as optional dep in `references/vitrinka.md`; screen-capture trigger phrases merged into description | User instruction |
| 10 | Old skill | Retire `~/.agents/skills/screen-capture` (+ `~/.claude` symlinks) after port verified; mv-to-backup with restore commands | Approved; prevents drift + double triggers |

## Assumptions

- peekaboo stays the recording engine (only surface with `capture live` diff-sampling + contact sheets); native ScreenCaptureKit replacement is out of v1 scope.
- Binary resolution via `src/ax/lib/runner.ts` pattern (repo-relative), never hardcoded HOME paths.
- Dirty non-ax files on the branch (telegram, utils) belong to feat/fixes work — never staged here.

## Fix inputs (agent #1 blind UX test, 9m44s, score 6/10)

1. **CRITICAL** — ambiguous `--window` substring silently resolves to wrong window (Find-in-page popup captured as "Brave - Main", `ok:true`, only tell = undocumented empty `window:""`). Fix: fail loud with candidate list when substring doesn't cleanly resolve to one window.
2. `run` top-level `ok:true` despite failed steps. Fix: `failedSteps` count at top level + documented semantics.
3. `find` lacks `--window`/`--subrole`/`--q` filters the other 9 commands have; help needs "Chromium-style apps expose text via AXDescription, not AXTitle — try --desc when --title returns 0".
4. `hotkey` has no `--app` targeting — goes to whatever has OS focus.
5. No `apps` command to discover valid `--app` values.
6. Transient popups (AXUnknown/AXHelpTag) pollute `window` output, indistinguishable from real windows.
7. No screenshot crop/region (`--crop` unknown option).
8. No wait-for-element primitive — only blunt global `delayMs` (covered by decision 7).
9. Promote preflight in top-level help ("run this first"); preflight groups only id'd elements — Brave shows `addressableCount:0` despite 191 desc-targetable elements → group by desc/title too.
10. set/type hard-verify (from handoff + user): before Cmd+A verify target app frontmost AND element AXFocused; after typing read back value; mismatch → retry once then loud error.

## Architecture notes

```
native/ax-tool/            Swift binary (all AX + CGEvent + preflight logic)
src/control/               commander CLI (renamed from src/ax)
  commands/                one file per command group
  lib/runner.ts            binary resolve + auto-build
  lib/capture…             ported capture-with-actions internals
src/macos/commands/control  tools macos control delegate
plugins/genesis-tools/skills/macos-control/
  SKILL.md + references/{capture,vitrinka}.md
```

Phases: originals committed (done) → verbatim script port → rename+breakdown (behavior frozen) → skill port → fix phase → unification (schema+preflight) → v1 last-step features → UX iteration 2 (sonnet blind test) until smooth.

## Open questions

- None blocking. Timing values in `set` (150ms/100ms) stay untouched until hard-verify lands (user froze changes).
