import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import { jsonlPath } from "@app/task/lib/paths";

const originalHome = process.env.GENESIS_TOOLS_HOME;
const dirs: string[] = [];

afterEach(() => {
    if (originalHome === undefined) {
        delete process.env.GENESIS_TOOLS_HOME;
    } else {
        process.env.GENESIS_TOOLS_HOME = originalHome;
    }

    for (const d of dirs) {
        rmSync(d, { recursive: true, force: true });
    }
});

function setupTempHome(): void {
    const dir = mkdtempSync(join(tmpdir(), "task-log-query-"));
    dirs.push(dir);
    process.env.GENESIS_TOOLS_HOME = dir;
}

describe("queryLogs", () => {
    it("filters stderr stream only", async () => {
        setupTempHome();
        const session = "test-session";
        const path = jsonlPath(session);
        await Bun.write(
            path,
            `${[
                '{"type":"line","seq":1,"out":"stdout","ts":1,"text":"OUT"}',
                '{"type":"line","seq":2,"out":"stderr","ts":2,"text":"ERR"}',
            ].join("\n")}\n`
        );

        const records = await readJsonlFile(path);
        const lines = filterLineRecords(records).filter((l) => l.out === "stderr");
        expect(lines.map((l) => l.text)).toEqual(["ERR"]);
    });
});
