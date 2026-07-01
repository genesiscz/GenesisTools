import { describe, expect, test } from "bun:test";
import type { CursorStreamAdapter } from "@app/utils/agents/adapters/cursor";
import { streamCursorAgent } from "./stream-agent";

describe("cursor streaming child exception safety", () => {
    test("kills the spawned process if the renderer throws mid-stream", async () => {
        const marker = `cursor-stream-test-${Date.now()}`;
        const proc = Bun.spawn({
            cmd: ["sh", "-c", `printf 'line1\\nline2\\n'; sleep 30 # ${marker}`],
            stdout: "pipe",
            stderr: "pipe",
        });

        const adapter = {
            parseLine: () => {
                throw new Error("forced renderer failure");
            },
        } as unknown as CursorStreamAdapter;

        await expect(
            streamCursorAgent(proc, {
                adapter,
            })
        ).rejects.toThrow("forced renderer failure");

        await new Promise((r) => setTimeout(r, 200));
        const after = Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim();
        expect(after).toBe("");
    });
});
