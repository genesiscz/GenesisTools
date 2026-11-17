# Notes export: build spec

**Status:** 2026-11-17 19:40, ready for an executor. One decision is open (D3).
**Goal:** `tools notes export` writes the notes of one project as one markdown file that a person can send.
**Non-goals:** no import, no sync, no change of the notes store.
**Executor:** this session after a compaction, on an Opus-class model. It reads only this file and what it links.

## Read this first after a compaction

- Standing orders of the owner (2026-11-17, word for word): "no review agents", "never push until I say".
- The progress is under "Progress" at the end of this file. Read it before you open any code.
- Easy to get wrong: the export never writes into the notes store; a private note is left out unless `--private`
  is given; the file name comes from the project name, never from the title of a note.

## Sources

- Handoff `h_ab12cd34` ("notes-export"), 3 open tasks: t1 (the command), t2 (private notes), t3 (the hub button).
  - Claim: `tools handoff claim h_ab12cd34`. Tick: `tools handoff check h_ab12cd34 <task> --proof "<command, where
    it ran, commit>"`. Deny: `tools handoff deny h_ab12cd34 <task> --reason "<why>"`. Comment: `tools handoff
    comment h_ab12cd34 "<text>"`.
- The truth table: 9 rows, checked 2026-11-17 at head 1a2b3c4d5e, all hold. It is in the plan folder beside this
  file (new).
- Repository rules that apply: `.claude/rules/tools.md`, `.claude/rules/code.md`.

## Interface freeze

```ts
// src/notes/lib/export.ts (new)
export interface ExportOptions {
    project: string;
    /** Private notes are left out unless this is true. */
    includePrivate: boolean;
}
export interface ExportResult {
    path: string;
    notes: number;
    skippedPrivate: number;
}
export function exportNotes(options: ExportOptions): ExportResult;
```

- Command line: `tools notes export <project> [--private] [--out <file>]`. It prints the path and the two counts.
- File name: `<project>-notes-<YYYY-MM-DD>.md` in the current folder, unless `--out` is given.

## Order

P1 starts now. P2 runs beside it, against the names above. P3 waits for the actions service of another plan and
for D3.

## Packages

### P1: the export library and the command

**Owner files:** `src/notes/lib/export.ts` (new), `src/notes/commands/export.ts` (new), `src/notes/lib/export.test.ts` (new)
**Needs:** nothing
**Handoff:** closes t1 of `h_ab12cd34`
**Decisions:**
1. The library returns the result; only the command prints. Ruled out: printing in the library, because the hub
   calls the same function.
2. The export reads through the store's reader. Ruled out: reading the files directly, because the reader already
   hides deleted notes.
**Done when:** `bun run test src/notes/lib/export.test.ts` passes, and `tools notes export demo` prints a path to
a file that holds every public note of the project `demo`.
**Targets:**
- ideally under 300 ms for 2,000 notes; way: one read of the index, no read per note; source: tool; if not: write
  the measured time into Progress and go on.
**Effort:** about two hours. Stop at the first version that passes the test.
**Not in this package:** private notes (P2), the hub button (P3).

### P2: private notes

**Owner files:** `src/notes/lib/private-filter.ts` (new), `src/notes/lib/private-filter.test.ts` (new)
**Needs:** P1 (interface)
**Handoff:** closes t2 of `h_ab12cd34`
**Decisions:**
1. A note is private when its front matter says so. The filter is one pure function that P1 calls. Ruled out: a
   flag in the store, because the store has no migration planned.
**Done when:** `bun run test src/notes/lib/private-filter.test.ts` passes: a private note is absent without
`--private` and present with it, and `skippedPrivate` counts it.
**Effort:** about one hour.

### P3: the hub button

**Owner files:** `src/hub/ui/notes-export-button.tsx` (new), `src/notes/lib/export-door.ts` (new)
**Needs:** P1 (built), external: the actions service (built)
**Handoff:** closes t3 of `h_ab12cd34`
**Decisions:**
1. The button calls `export-door.ts`, the one adapter for the call. The swap to the actions service changes only
   that file.
**Done when:** `bun run test src/notes/lib/export-door.test.ts` (new) passes with a fake service. The window check
is one click on the button in the running hub, after D3.
**Effort:** about two hours.

## Rules for the executor

- A package is done when its "Done when" holds and the gate passes. Tick its handoff task, then start the next.
- A number shows a direction. It is a gate only where the package says `gate: yes`.
- A target that a measurement shows as out of reach: write the number and the reason into Progress and go on. Ask
  the owner about all limits in one question at the end.
- While you verify, fix a new thing only when it loses data, shows an invented fact or blocks the package. Each
  other thing is one line under "Seen, not fixed".
- The handoff tasks and Progress are the only lists.
- The gate of every package: the tests of the touched folders, the lint rules, the typecheck.
- After a compaction, read the first block of this file before the next tool call.

## Decisions

- **D1 (answered b):** "one file per project, not one per note"
- **D2 (answered a):** "private stays out unless I ask for it"
- **D3 (open, blocks P3):** where does the button stand: in the project header, or in the notes list toolbar?

Decisions the planner made:
- The file is markdown, not HTML: every mail client and chat shows it.

## Progress

## Seen, not fixed

## Deviations
