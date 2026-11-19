import { beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { makeTempDir } from "@genesiscz/utils/paths";
import { atomicWriteIo } from "@genesiscz/utils/storage/atomic-file";
import { NOTIFY_ACTIONS, workConfigFileSchema } from "./rules/config";
import { type NotifyEdit, setWorkNotifyConfig } from "./rules/load";

const project = "Orchard.App";
let configPath: string;
const stored = () => workConfigFileSchema.parse(SafeJSON.parse(readFileSync(configPath, "utf8"), { strict: true }));
const set = (notify: NotifyEdit) => setWorkNotifyConfig({ configPath, scope: "project", project, notify });

beforeEach(() => {
    configPath = join(makeTempDir("work-notify-edit-"), "config.json");
    writeFileSync(
        configPath,
        SafeJSON.stringify({
            version: 2,
            global: { rules: { notify: { task: { finished: "off" } } } },
            projects: {
                [project]: {
                    rules: {
                        notify: {
                            bug: {
                                spotted: "inbox",
                                reopened: { level: "banner", minSeverity: "high" },
                            },
                        },
                    },
                },
            },
        })
    );
});

test("a project cell keeps its severity floor on edit and removes the whole rule on reset", async () => {
    expect((await set({ type: "bug", action: "reopened", level: "off" })).ok).toBe(true);
    expect(stored().projects?.[project]?.rules?.notify?.bug?.reopened).toEqual({ level: "off", minSeverity: "high" });
    expect((await set({ type: "bug", action: "reopened", level: null })).ok).toBe(true);
    expect(stored().projects?.[project]?.rules?.notify?.bug).toEqual({ spotted: "inbox" });
    expect(stored().global?.rules?.notify?.task?.finished).toBe("off");
});

test("a project row is one atomic write and Undo restores its distinct raw rules", async () => {
    const before = stored();
    const writes = spyOn(atomicWriteIo, "writeSync");
    try {
        const result = await set({ type: "bug", action: "*", level: "list" });
        expect(writes).toHaveBeenCalledTimes(1);
        if (!result.ok) {
            throw new Error(result.problem);
        }
        expect(result.changed).toHaveLength(NOTIFY_ACTIONS.length);
        expect(Object.keys(stored().projects?.[project]?.rules?.notify?.bug ?? {}).sort()).toEqual(
            [...NOTIFY_ACTIONS].sort()
        );
        expect((await setWorkNotifyConfig({ configPath, project, scope: "project", restore: result.changed })).ok).toBe(
            true
        );
        expect(stored()).toEqual(before);
        expect(writes).toHaveBeenCalledTimes(2);
    } finally {
        writes.mockRestore();
    }
});

test("a global column skips repository rules; concurrent changes survive a refused Undo", async () => {
    const result = await setWorkNotifyConfig({
        configPath,
        scope: "global",
        lockedCells: new Set(["task:spotted"]),
        notify: { type: "*", action: "spotted", level: "off" },
    });
    if (!result.ok) {
        throw new Error(result.problem);
    }
    expect(stored().global?.rules?.notify?.task).toEqual({ finished: "off" });
    expect(stored().global?.rules?.notify?.bug?.spotted).toBe("off");
    await setWorkNotifyConfig({
        configPath,
        scope: "global",
        notify: { type: "todo", action: "spotted", level: "inbox" },
    });
    const concurrent = readFileSync(configPath, "utf8");
    expect(await setWorkNotifyConfig({ configPath, scope: "global", restore: result.changed })).toMatchObject({
        ok: false,
        code: "RULE_CHANGED",
    });
    expect(readFileSync(configPath, "utf8")).toBe(concurrent);
});

test("dry run, no change and three invalid requests leave config alone", async () => {
    const before = readFileSync(configPath, "utf8");
    const notify = { type: "bug", action: "spotted", level: "inbox" } as const;
    expect(await set(notify)).toMatchObject({ ok: true, changed: [] });
    for (const [selectedProject, code] of [
        [undefined, "PROJECT_REQUIRED"],
        ["Unknown", "UNKNOWN_PROJECT"],
    ] as const) {
        expect(
            await setWorkNotifyConfig({ notify, scope: "project", project: selectedProject, configPath })
        ).toMatchObject({ ok: false, code });
    }
    expect(await set({ type: "*", action: "*", level: "inbox" })).toMatchObject({ ok: false, code: "TOO_WIDE" });
    const absent = join(makeTempDir("work-notify-preview-"), "absent", "config.json");
    expect(await setWorkNotifyConfig({ scope: "global", notify, configPath: absent, dryRun: true })).toMatchObject({
        ok: true,
        changed: [{ from: null, to: "inbox" }],
    });
    expect(existsSync(absent)).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(before);
});
