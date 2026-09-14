import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Guards the `tools` dispatcher at the repo root.
 *
 * `TOOL_ALIASES` was an object literal, so `TOOL_ALIASES[scriptId]` resolved
 * keys off `Object.prototype`: `tools constructor` got the `Object` function
 * back, died on `alias.slice`, and reported a bare "unexpected error" instead
 * of reaching the "Tool not found" path. These names cannot fuzzy-match a real
 * tool, so the dispatcher exits rather than opening the interactive picker.
 */
const ROOT = join(import.meta.dir, "..");

function runTools(name: string): { status: number | null; output: string } {
    const result = spawnSync("bun", [join(ROOT, "tools"), name], {
        cwd: ROOT,
        encoding: "utf-8",
        env: process.env,
        timeout: 60_000,
    });

    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("tools dispatcher", () => {
    it.each(["constructor", "toString", "hasOwnProperty"])(
        "reports %s as an unknown tool instead of crashing",
        (name) => {
            const { status, output } = runTools(name);

            expect(output).toContain("Tool not found");
            expect(output).not.toContain("unexpected error");
            expect(status).toBe(1);
        }
    );

    it("treats an ordinary unknown name the same way", () => {
        const { status, output } = runTools("zzznotarealtool");

        expect(output).toContain("Tool not found");
        expect(status).toBe(1);
    });
});
