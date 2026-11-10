/**
 * Which `src/` names are tools, for every list of tools: the launcher's `tools --help`, the
 * picker and the update catalogue (`src/tools/lib/discovery.ts`), Jev's route catalogue, and the
 * CI check of written `tools …` commands. The launcher loads this module at start, so it imports
 * nothing.
 */

/**
 * `src/` folders that carry an `index.ts` but are not tools a person picks from a list.
 * `src/utils/index.ts` is the `@genesiscz/utils` barrel and prints nothing when run. `Internal`
 * still runs by name (`tools internal reas`); it is only kept out of the lists.
 */
export const NON_TOOL_FOLDERS: ReadonlySet<string> = new Set(["utils", "Internal", "components", "lib"]);

/**
 * Names that read like tools but are subcommands of one.
 *
 * `tools calendar --help` answered "Tool not found: calendar" while the CHANGELOG advertised
 * that exact command, so an agent looking for the calendar had nothing to follow (observed
 * 2026-09-09). The short form is made real here rather than corrected in every document that
 * already uses it.
 *
 * A Map, not an object literal: a plain-object lookup resolves inherited keys, so
 * `tools constructor` returned `Object` and died on `alias.slice` before it could reach the
 * "Tool not found" path.
 */
export const TOOL_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
    ["calendar", ["macos", "calendar"]],
    ["reminders", ["macos", "reminders"]],
    // src/voice-memos/ is a stray README from before this tool moved under src/macos (#446.9);
    // `tools voice-memos` reported "Tool not found" instead of pointing at the real command.
    ["voice-memos", ["macos", "voice-memos"]],
    // `tools usage` moved under the tool whose database it reads.
    ["usage", ["ask", "usage"]],
]);
