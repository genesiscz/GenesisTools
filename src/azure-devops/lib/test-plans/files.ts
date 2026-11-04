import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLocalConfigDir } from "@app/azure-devops/config";
import { SafeJSON } from "@genesiscz/utils/json";

/** Snapshots of what `testplan` commands showed, next to `tasks/`: `<config dir>/testplans/`. */
export function testPlansDir(): string {
    return join(getLocalConfigDir(), "testplans");
}

export type SnapshotName = `plan-${number}` | `suite-${number}-${number}` | `case-${number}`;

/** Writes `<name>.md` and `<name>.json`; returns the markdown path. */
export async function saveSnapshot(name: SnapshotName, markdown: string, data: unknown): Promise<string> {
    const dir = testPlansDir();
    await mkdir(dir, { recursive: true });
    const mdPath = join(dir, `${name}.md`);
    await writeFile(mdPath, `${markdown}\n`);
    await writeFile(join(dir, `${name}.json`), `${SafeJSON.stringify(data, null, 2)}\n`);
    return mdPath;
}
