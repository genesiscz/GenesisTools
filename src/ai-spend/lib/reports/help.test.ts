import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SOURCE_IDS, SOURCE_REPORTS } from "./types";

const AI_SPEND = join(import.meta.dir, "../../index.ts");

async function help(args: string[]): Promise<string> {
    const proc = Bun.spawn(["bun", AI_SPEND, ...args, "--help"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return `${stdout}\n${stderr}`;
}

describe("ai-spend command tree", () => {
    it("lists every ccusage command path from the live inventory", async () => {
        const root = await help([]);
        for (const name of [
            "daily",
            "weekly",
            "monthly",
            "session",
            "blocks",
            "statusline",
            "summary",
            "sessions",
            "today",
            "monitor",
            ...SOURCE_IDS,
        ]) {
            expect(root).toContain(name);
        }

        for (const source of SOURCE_IDS) {
            const nested = await help([source]);

            for (const kind of SOURCE_REPORTS[source]) {
                expect(nested).toContain(kind);
            }
        }
    });
});
