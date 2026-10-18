import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { persistentFixture } from "@genesiscz/utils/test/persistent-fixture";

/**
 * A folder of fake tools a test starts (`name` to script body), made once per set of bodies and kept. Put it on PATH or
 * start a file in it by path. Returns the folder.
 *
 * A fake tool written into the per-run temp root is started and then deleted with that root, the syspolicyd trap in
 * .claude/rules/tests.md. The key is every name and body, so a changed body gives a new folder, and the folder holds
 * exactly the programs asked for. A body must not embed a per-test path: pass that path in an environment variable,
 * so one kept script serves every test.
 */
export function keptBin(programs: Record<string, string>): string {
    const entries = Object.entries(programs).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) {
        throw new Error("keptBin needs at least one program");
    }

    const key = ["kept-bin", ...entries.map(([name, body]) => `${name}\0${body}`)].join("\0\0");
    let folder = "";
    for (const [name, body] of entries) {
        folder = dirname(
            persistentFixture(name, key, (draft) => {
                writeFileSync(draft, body);
                chmodSync(draft, 0o755);
            })
        );
    }

    return folder;
}

/** One kept fake tool (see `keptBin`). Returns its path; its folder holds only it. */
export function keptExecutable(name: string, body: string): string {
    return join(keptBin({ [name]: body }), name);
}
