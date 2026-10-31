import { describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { FileTailer } from "./file-tailer";

describe("FileTailer<T>", () => {
    it("emits only newly-appended JSON lines (no replay of pre-existing)", async () => {
        const f = join(mkdtempSync(join(tmpdir(), "ft-")), "log.jsonl");
        writeFileSync(f, `${SafeJSON.stringify({ id: "old" })}\n`);
        const seen: string[] = [];
        const t = new FileTailer<{ id: string }>(f, { onLine: (e) => seen.push(e.id) });
        t.start();
        appendFileSync(f, `${SafeJSON.stringify({ id: "new1" })}\n${SafeJSON.stringify({ id: "new2" })}\n`);
        await Bun.sleep(500);
        t.stop();
        expect(seen).toEqual(["new1", "new2"]);
    });

    it("resets on truncation (file cleared then re-appended)", async () => {
        const f = join(mkdtempSync(join(tmpdir(), "ft-")), "log.jsonl");
        writeFileSync(f, `${SafeJSON.stringify({ id: "a" })}\n`);
        const seen: string[] = [];
        const t = new FileTailer<{ id: string }>(f, { onLine: (e) => seen.push(e.id) });
        t.start();
        writeFileSync(f, `${SafeJSON.stringify({ id: "fresh" })}\n`); // truncate + rewrite
        await Bun.sleep(500);
        t.stop();
        expect(seen).toEqual(["fresh"]); // reset must emit ONLY post-truncation data, no stale "a" replay
    });

    it("starts at a given offset and never creates a missing file when create is false", () => {
        const dir = mkdtempSync(join(tmpdir(), "ft-"));
        const f = join(dir, "log.jsonl");
        const first = `${SafeJSON.stringify({ id: "backlog" })}\n`;
        writeFileSync(f, `${first}${SafeJSON.stringify({ id: "after" })}\n`);
        const seen: string[] = [];
        const t = new FileTailer<{ id: string }>(f, { onLine: (e) => seen.push(e.id) }, { from: first.length });
        t.start();
        t.flush();
        t.stop();
        expect(seen).toEqual(["after"]);

        const missing = join(dir, "later", "log.jsonl");
        const watcher = new FileTailer(missing, { onLine: () => {} }, { create: false });
        watcher.start();
        watcher.stop();
        expect(existsSync(missing)).toBe(false);
    });
});
