import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rehearseHistoryCorpus } from "./corpus-rehearsal";

test("corpus rehearsal migrates only its disposable copy and preserves protected observations", async () => {
    const root = await mkdtemp(join(tmpdir(), "history-rehearsal-test-"));
    const source = join(root, "canonical.db");
    const db = new Database(source);
    db.exec(
        "CREATE TABLE usage_snapshots(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO usage_snapshots VALUES(1,'kept usage'); CREATE TABLE spend_snapshots(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO spend_snapshots VALUES(1,'kept spend');"
    );
    db.close();
    const hash = async () =>
        createHash("sha256")
            .update(await readFile(source))
            .digest("hex");
    const before = await hash();
    const report = await rehearseHistoryCorpus({
        source,
        output: join(root, "report.json"),
        roots: { claude: [], codex: [], grok: [] },
    });
    expect(report.protectedDataPreserved).toBe(true);
    expect(report.withinBudget).toBe(true);
    expect(report.providers.map((provider) => provider.sources)).toEqual([0, 0, 0]);
    expect(await hash()).toBe(before);
    expect((await readdir(root)).sort()).toEqual(["canonical.db", "report.json"]);
    await expect(rehearseHistoryCorpus({ source, output: source })).rejects.toThrow("must not overwrite");
});
