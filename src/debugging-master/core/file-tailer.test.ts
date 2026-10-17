import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { FileTailer } from "@app/debugging-master/core/file-tailer";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

it("relative storage overrides keep session paths absolute and contained", async () => {
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: "relative-session-fixture" }, async () => {
        const modulePath = `${import.meta.dir}/paths.ts?relative-storage-regression`;
        const { SESSIONS_DIR, sessionFilePath } = await import(modulePath);
        expect(isAbsolute(SESSIONS_DIR)).toBe(true);
        expect(SESSIONS_DIR).toBe(
            resolve("relative-session-fixture", ".genesis-tools", "debugging-master", "sessions")
        );
        expect(sessionFilePath("valid-session")).toBe(join(SESSIONS_DIR, "valid-session.jsonl"));
        expect(() => sessionFilePath("../escape")).toThrow("Invalid session name");
        expect(() => sessionFilePath(resolve("outside-session"))).toThrow("Invalid session name");
    });
});

describe("FileTailer truncation", () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("notifies onTruncated when the jsonl file is cleared", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-file-tailer-"));
        dirs.push(dir);
        const path = join(dir, "session.jsonl");
        writeFileSync(path, `${SafeJSON.stringify({ type: "line", seq: 1, text: "old" })}\n`);

        const entries: number[] = [];
        let truncated = 0;
        const tailer = new FileTailer(path, {
            onEntry: (_entry, index) => {
                entries.push(index);
            },
            onTruncated: () => {
                truncated++;
            },
        });

        tailer.start();
        await Bun.sleep(50);

        writeFileSync(path, "");
        await Bun.sleep(400);

        writeFileSync(path, `${SafeJSON.stringify({ type: "line", seq: 1, text: "fresh" })}\n`);
        await Bun.sleep(400);

        tailer.stop();

        expect(truncated).toBeGreaterThan(0);
        expect(entries).toContain(1);
    });
});
