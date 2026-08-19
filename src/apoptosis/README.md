# tools apoptosis

> **Programmed cell death for dead code: flag zero-signal files, suggest deletion after a grace window.**

Named after the biological process, and built on the same principle: a cell dies only after it stops receiving every survival signal, and only after a delay. This tool never deletes anything itself.

---

## Quick start

```bash
tools apoptosis                                  # scan, mark candidates
tools apoptosis src/                             # scan a subtree
tools apoptosis --coverage coverage/coverage-final.json
tools apoptosis status                           # what is currently marked, no scan
tools apoptosis kill                             # emit a deletion script
tools apoptosis kill --pr-body                   # emit a Markdown checklist instead
tools apoptosis rescue src/utils/keep-me.ts      # clear a death mark
tools apoptosis reset                            # clear all state
tools apoptosis --json | tools json
```

## Commands

| Command | Description |
|---------|-------------|
| (default) | Scan and mark candidates |
| `status [dir]` | Show the persisted state file, no scan |
| `kill [dir]` | Emit a deletion shell script, or `--pr-body` for a checklist. Deletes nothing. |
| `rescue <file> [dir]` | Manually clear the death mark on a file |
| `reset` | Clear the entire state file |

## Options

| Flag | Description |
|------|-------------|
| `-d, --days <n>` | Churn lookback window in days (default: 90) |
| `-g, --grace <n>` | Grace period in days before a mark graduates (default: 14) |
| `-e, --ext <list>` | Extensions to consider (default: `ts,tsx,js,jsx`) |
| `-i, --ignore <list>` | Path segments to skip (default: `node_modules,dist,.git,build,coverage`) |
| `--coverage <file>` | Istanbul or nyc JSON coverage file, treated as a survival signal |
| `--no-state` | Pure scan: do not read or write the state file |
| `--json` | Emit the full report as JSON |
| `--readme` | Print this file and exit |

---

## How "dead" is decided

A file becomes a candidate only when **every** survival signal is zero:

- no commits touching it inside the churn window (from git),
- no other scanned file imports it,
- with `--coverage`, no covered lines.

A candidate then has to stay dead across the whole grace window before `kill` will suggest it. One scan can never produce a deletion, by design.

## ⚠️ Accuracy caveats on import detection

Imports are matched textually. The tool **does** resolve relative specifiers (`./foo`), tsconfig `paths` aliases (`@app/*`, `@ui`, read from the nearest `tsconfig.json`), static `from` imports, side-effect imports (`import "./foo"`), and dynamic `import()` / `require()` calls.

It does **not** resolve:

- imports built from computed strings,
- paths declared only in an `extends`-ed base tsconfig,
- cross-package specifiers.

A file reached only through those routes can be flagged wrongly.

**Framework entry points are imported by nobody and will surface as candidates by design.** Test files, CLI mains and `*.config.ts` all look dead from the inside. `rescue` the real entry points, or add them to `--ignore`. The grace window plus your own review are the backstop, which is exactly why `kill` writes a script for you to read instead of running one.

## Notes

- `kill --pr-body` is the reviewable path: it produces a Markdown checklist you can paste into a PR, so deletions get discussed rather than discovered.
- `--no-state` makes the scan read-only, which is what you want in CI or when experimenting with thresholds.
- 🛑 Read the generated script before running it. It is a suggestion built from heuristics, not a verdict.
