/**
 * The files under src/utils that still name a `tools …` command, counted 2026-10-22 when lint-rules
 * `no-tool-command-in-utils` was added: 124 literals in 52 files. Emptied on 2026-11-01: a util now imports the
 * function for each command it names from src/utils/genesis-tools/tools/ (`ai.ts`, `system.ts`, `services.ts`, and
 * `suggest.ts` for a line built with `suggestCommand()`), the one folder the rule allows. A ratchet: no file may join
 * this list, and `lint-rules.test.ts` fails when a listed file no longer names a command.
 */
export const TOOL_COMMAND_RATCHET: ReadonlySet<string> = new Set<string>([]);
