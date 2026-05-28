import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { JsonlWriter } from "./jsonl-writer";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs) {
        rmSync(d, { recursive: true, force: true });
    }
});

describe("JsonlWriter", () => {
    it("appends one JSON object per line", () => {
        const dir = mkdtempSync(join(tmpdir(), "jw-"));
        dirs.push(dir);
        const path = join(dir, "s.jsonl");
        const w = new JsonlWriter(path);
        w.append({ type: "line", seq: 1, text: "a" });
        const line = readFileSync(path, "utf8").trim();
        expect(SafeJSON.parse(line, { strict: true, jsonl: true }).seq).toBe(1);
    });
});
