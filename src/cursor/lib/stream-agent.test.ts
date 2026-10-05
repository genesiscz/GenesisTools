import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CursorStreamAdapter } from "@genesiscz/utils/agents/adapters/cursor";
import { SafeJSON } from "@genesiscz/utils/json";
import { streamCursorAgent } from "./stream-agent";

describe("cursor streaming child exception safety", () => {
    test("kills the spawned process if the renderer throws mid-stream", async () => {
        const marker = `cursor-stream-test-${Date.now()}`;
        const proc = Bun.spawn({
            env: process.env,
            cmd: ["sh", "-c", `printf 'line1\\nline2\\n'; sleep 30 # ${marker}`],
            stdout: "pipe",
            stderr: "pipe",
        });

        const adapter = {
            parseLine: () => ({
                textDelta: undefined,
                blocks: [{ type: "metadata" as const, content: "test" }],
                done: false,
            }),
        } as unknown as CursorStreamAdapter;

        const renderer = {
            render: () => {
                throw new Error("forced renderer failure");
            },
        };

        await expect(
            streamCursorAgent(proc, {
                adapter,
                renderer,
            })
        ).rejects.toThrow("forced renderer failure");

        await new Promise((r) => setTimeout(r, 200));
        const after = Bun.spawnSync(["pgrep", "-f", marker], { env: process.env }).stdout.toString().trim();
        expect(after).toBe("");
    });
});

describe("streamCursorAgent against a fake cursor child", () => {
    const assistant = (text: string, timestamp?: number) =>
        SafeJSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text }] },
            ...(timestamp ? { timestamp_ms: timestamp } : {}),
        });

    function fakeCursor(script: string): ReturnType<typeof Bun.spawn> {
        return Bun.spawn({ env: process.env, cmd: ["sh", "-c", script], stdout: "pipe", stderr: "pipe" });
    }

    test("streams the answer text and exits 0", async () => {
        const lines = [
            SafeJSON.stringify({ type: "system", model: "fake-model", cwd: "/tmp/ws" }),
            assistant("po", 1),
            assistant("pong", 2),
            SafeJSON.stringify({ type: "result", subtype: "success", duration_ms: 1200, usage: { outputTokens: 1 } }),
        ];
        const file = join(mkdtempSync(join(tmpdir(), "cursor-stream-")), "events.ndjson");
        writeFileSync(file, `${lines.join("\n")}\n`);
        const proc = fakeCursor(`cat '${file}'`);
        const text: string[] = [];

        const code = await streamCursorAgent(proc, { onTextDelta: (delta) => text.push(delta) });

        expect(code).toBe(0);
        expect(text.join("")).toBe("pong");
    });

    test("hands the child's own error text to onStderr when it exits non-zero", async () => {
        const proc = fakeCursor(
            "printf '\\033[2K\\033[GError: Authentication required. Run the login first.\\n' >&2; exit 1"
        );
        const errors: string[] = [];

        const code = await streamCursorAgent(proc, { onStderr: (text) => errors.push(text) });

        expect(code).toBe(1);
        expect(errors).toEqual(["Error: Authentication required. Run the login first."]);
    });

    test("stays quiet on stderr when the child succeeds", async () => {
        const proc = fakeCursor("printf 'warning\\n' >&2; exit 0");
        const errors: string[] = [];

        await streamCursorAgent(proc, { onStderr: (text) => errors.push(text) });

        expect(errors).toEqual([]);
    });
});
