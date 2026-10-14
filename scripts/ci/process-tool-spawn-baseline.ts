/**
 * The `no-process-tool-spawn` findings that existed when the rule landed (2026-10-14 01:20; absolute paths, the
 * `{ cmd }` form, `env` and `Bun.which` from 02:20), counted per file. A file may keep at most this many; one
 * more spawn in a listed file, or any spawn in an unlisted file, fails lint-rules.
 * When you move a call site to `@genesiscz/utils/process`, run `bun scripts/ci/lint-rules.ts --update-process-baseline`,
 * which lowers the counts and refuses to raise one.
 */
export const PROCESS_TOOL_SPAWN_BASELINE: Readonly<Record<string, number>> = {
    "src/macos/lib/swap/scanner.ts": 1,
};
