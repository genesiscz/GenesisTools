import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * `presentAuthUrl()` returns false when the user cancels the browser-choice
 * prompt, and every caller MUST abort instead of falling through to the code
 * prompt. Three of four callers honored that when the contract changed; the
 * fourth (`login-secondary`) silently ignored it and kept prompting.
 *
 * A behavioural test would need a TTY harness, so this pins the contract
 * statically: every call site must consume the boolean.
 */

const COMMANDS_DIR = dirname(Bun.fileURLToPath(import.meta.url));
const SEARCH_ROOTS = [COMMANDS_DIR, join(COMMANDS_DIR, "..", "..", "ask", "commands")];

async function tsFilesIn(dir: string): Promise<string[]> {
    try {
        const entries = await readdir(dir, { withFileTypes: true });

        return entries
            .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
            .map((e) => join(dir, e.name));
    } catch {
        // A missing sibling tree (layout change) must not silently pass the test.
        return [];
    }
}

/** A call whose result is ignored: `await presentAuthUrl(...)` as a bare statement. */
const IGNORED_CALL = /(?<![!(=]\s*)(?<!\w)await presentAuthUrl\([^)]*\);/;

describe("presentAuthUrl cancellation contract", () => {
    test("every caller consumes the returned boolean", async () => {
        const files = (await Promise.all(SEARCH_ROOTS.map(tsFilesIn))).flat();
        expect(files.length).toBeGreaterThan(0);

        const offenders: string[] = [];
        let callers = 0;

        for (const file of files) {
            const source = await Bun.file(file).text();

            if (!source.includes("presentAuthUrl(")) {
                continue;
            }

            // The declaration itself lives in config.ts alongside its callers.
            const callSites = source
                .split("\n")
                .filter((line) => line.includes("presentAuthUrl(") && !line.includes("export async function"));

            if (callSites.length === 0) {
                continue;
            }

            callers += 1;

            for (const line of callSites) {
                if (IGNORED_CALL.test(line)) {
                    offenders.push(`${file}: ${line.trim()}`);
                }
            }
        }

        expect(callers).toBeGreaterThan(0);
        expect(offenders).toEqual([]);
    });
});
