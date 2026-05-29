import { setupStorageSandbox } from "@app/utils/storage/test-sandbox";

setupStorageSandbox();

import { describe, expect, it } from "bun:test";
import { jsonlPath } from "@app/task/lib/paths";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";

describe("queryLogs", () => {
    it("filters stderr stream only", async () => {
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
