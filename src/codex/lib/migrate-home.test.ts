import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { OpenFilesQuery, OpenFilesResult } from "@genesiscz/utils/process/open-files";
import {
    type DesktopState,
    discoverSourceHomes,
    enumerateRollouts,
    mergeDesktopState,
    migrateHome,
    normaliseRootPath,
} from "./migrate-home";

const roots: string[] = [];

function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), "codex-migrate-home-"));
    roots.push(root);
    return root;
}

afterEach(() => {
    // The fixtures live under the OS temp directory and are small; leaving them costs nothing and
    // keeps a failing assertion inspectable.
    roots.length = 0;
});

interface RolloutSpec {
    date: string;
    uuid: string;
    cwd?: string;
    body?: string;
}

function makeHome(root: string, name: string, rollouts: RolloutSpec[], state?: DesktopState): string {
    const home = join(root, name);
    mkdirSync(join(home, "sessions"), { recursive: true });

    for (const rollout of rollouts) {
        const [year, month, day] = rollout.date.split("-");
        const directory = join(home, "sessions", year, month, day);
        mkdirSync(directory, { recursive: true });
        const meta = SafeJSON.stringify({
            type: "session_meta",
            payload: {
                id: rollout.uuid,
                session_id: rollout.uuid,
                cwd: rollout.cwd ?? "/Users/example/project",
            },
        });
        writeFileSync(
            join(directory, `rollout-${rollout.date}T00-00-00-${rollout.uuid}.jsonl`),
            `${meta}\n${rollout.body ?? SafeJSON.stringify({ type: "turn", payload: { text: rollout.uuid } })}\n`
        );
    }

    if (state) {
        writeFileSync(join(home, ".codex-global-state.json"), SafeJSON.stringify(state));
    }

    return home;
}

function uuid(suffix: string): string {
    return `01a07dd8-4417-7be3-b922-74db43df${suffix}`;
}

/** Path + size + content digest of every file below `root`, so "nothing was written" is checkable. */
function treeFingerprint(root: string): string {
    const lines: string[] = [];

    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name)
        )) {
            const path = join(directory, entry.name);

            if (entry.isDirectory()) {
                walk(path);
                continue;
            }

            lines.push(
                `${relative(root, path)} ${statSync(path).size} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`
            );
        }
    };

    walk(root);
    return lines.join("\n");
}

const clear = (): OpenFilesResult => [];

function busyOn(home: string): (query: OpenFilesQuery) => OpenFilesResult {
    return (query) => {
        const sessions = join(home, "sessions");

        if ((query.directories ?? []).includes(sessions)) {
            return [{ pid: 4242, command: "codex", path: join(sessions, "held.jsonl") }];
        }

        return [];
    };
}

describe("migrateHome transcripts", () => {
    test("unions every source into the destination without loss or duplication, and repeats as a no-op", async () => {
        const root = scratch();
        const destination = makeHome(root, ".codex", [{ date: "2026-08-01", uuid: uuid("0001") }]);
        const alpha = makeHome(root, ".codex-alpha", [
            { date: "2026-09-07", uuid: uuid("0002") },
            { date: "2026-09-08", uuid: uuid("0003") },
        ]);
        const beta = makeHome(root, ".codex-beta", [{ date: "2026-09-06", uuid: uuid("0004") }]);

        const first = await migrateHome({
            from: [alpha, beta],
            to: destination,
            apply: true,
            backupRoot: join(root, "backups"),
            stamp: "20260909-221500",
            inspectOpenFiles: clear,
        });

        expect(first.refusals).toEqual([]);
        expect(first.applied).toBe(true);
        expect(first.totals).toMatchObject({ rollouts: 3, toCopy: 3, alreadyPresent: 0, collisions: 0, copied: 3 });

        const migrated = enumerateRollouts(join(destination, "sessions"));
        expect(migrated).toHaveLength(4);
        expect(new Set(migrated.map((file) => file.nativeId)).size).toBe(4);

        for (const home of [alpha, beta]) {
            for (const file of enumerateRollouts(join(home, "sessions"))) {
                const landed = join(destination, "sessions", file.relativePath);
                expect(existsSync(landed)).toBe(true);
                expect(readFileSync(landed)).toEqual(readFileSync(file.path));
            }
        }

        expect(first.backups.sessions).toBe(join(root, "backups", "20260909-221500", "sessions"));
        expect(existsSync(join(root, "backups", "20260909-221500", "sessions"))).toBe(true);

        const after = treeFingerprint(destination);
        const second = await migrateHome({
            from: [alpha, beta],
            to: destination,
            apply: true,
            backupRoot: join(root, "backups"),
            stamp: "20260909-221600",
            inspectOpenFiles: clear,
        });

        expect(second.refusals).toEqual([]);
        expect(second.totals).toMatchObject({ rollouts: 3, toCopy: 0, alreadyPresent: 3, collisions: 0, copied: 0 });
        expect(treeFingerprint(destination)).toBe(after);
    });

    test("preserves the source date tree rather than re-deriving it from the header timestamp", async () => {
        const root = scratch();
        const destination = makeHome(root, ".codex", []);
        const source = makeHome(root, ".codex-alpha", [{ date: "2026-09-07", uuid: uuid("0011") }]);

        await migrateHome({
            from: [source],
            to: destination,
            apply: true,
            backupRoot: join(root, "backups"),
            stamp: "s",
            inspectOpenFiles: clear,
        });

        expect(enumerateRollouts(join(destination, "sessions"))[0]?.relativePath).toBe(
            join("2026", "09", "07", `rollout-2026-09-07T00-00-00-${uuid("0011")}.jsonl`)
        );
    });

    test("refuses the whole run on a native-id collision and writes nothing", async () => {
        const root = scratch();
        const destination = makeHome(root, ".codex", [{ date: "2026-08-01", uuid: uuid("0021"), body: "{}" }]);
        const source = makeHome(root, ".codex-alpha", [{ date: "2026-09-07", uuid: uuid("0021") }]);
        const before = treeFingerprint(destination);

        const report = await migrateHome({
            from: [source],
            to: destination,
            apply: true,
            backupRoot: join(root, "backups"),
            stamp: "s",
            inspectOpenFiles: clear,
        });

        expect(report.applied).toBe(false);
        expect(report.totals.collisions).toBe(1);
        expect(report.refusals.map((refusal) => refusal.reason)).toContain("collision");
        expect(report.sources[0]?.collisions[0]?.sourceMeta.id).toBe(uuid("0021"));
        expect(treeFingerprint(destination)).toBe(before);
        expect(existsSync(join(root, "backups"))).toBe(false);
    });

    test("copies while a home's databases are held open, and skips only the rollout a process still writes", async () => {
        const root = scratch();
        const destination = makeHome(root, ".codex", []);
        const source = makeHome(root, ".codex-alpha", [
            { date: "2026-09-07", uuid: uuid("0031") },
            { date: "2026-09-07", uuid: uuid("0032") },
        ]);
        const live = enumerateRollouts(join(source, "sessions")).find((file) => file.nativeId === uuid("0031"));
        expect(live).toBeDefined();
        // Codex holds its sqlite files and the rollout it is appending to; the other rollout is free.
        const holding = (query: OpenFilesQuery): OpenFilesResult =>
            (query.directories ?? []).includes(join(source, "sessions"))
                ? [
                      { pid: 4242, command: "codex", path: join(source, "logs_2.sqlite") },
                      { pid: 4242, command: "codex", path: live?.path ?? "" },
                  ]
                : [];

        const first = await migrateHome({
            from: [source],
            to: destination,
            apply: true,
            backupRoot: join(root, "backups"),
            stamp: "s1",
            inspectOpenFiles: holding,
        });

        expect(first.refusals).toEqual([]);
        expect(first.applied).toBe(true);
        expect(first.busy.find((entry) => entry.home === source)?.status).toBe("busy");
        expect(first.sources[0]?.copied).toBe(1);
        expect(first.sources[0]?.skippedLive.map((entry) => entry.nativeId)).toEqual([uuid("0031")]);
        expect(first.sources[0]?.skippedLive[0]?.holders.map((holder) => holder.pid)).toEqual([4242]);
        expect(first.totals.skippedLive).toBe(1);
        expect(enumerateRollouts(join(destination, "sessions")).map((file) => file.nativeId)).toEqual([uuid("0032")]);

        const second = await migrateHome({
            from: [source],
            to: destination,
            apply: true,
            backupRoot: join(root, "backups"),
            stamp: "s2",
            inspectOpenFiles: clear,
        });

        expect(second.sources[0]?.copied).toBe(1);
        expect(second.sources[0]?.alreadyPresent).toBe(1);
        expect(second.totals.skippedLive).toBe(0);
        expect(enumerateRollouts(join(destination, "sessions"))).toHaveLength(2);
    });

    test("--archive-source refuses while the source is held open, so a live process never loses its sessions directory", async () => {
        const root = scratch();
        const destination = makeHome(root, ".codex", []);
        const source = makeHome(root, ".codex-alpha", [{ date: "2026-09-07", uuid: uuid("0034") }]);
        const before = treeFingerprint(destination);

        const report = await migrateHome({
            from: [source],
            to: destination,
            apply: true,
            archiveSource: true,
            backupRoot: join(root, "backups"),
            stamp: "s",
            inspectOpenFiles: busyOn(source),
        });

        expect(report.applied).toBe(false);
        expect(report.refusals.map((refusal) => refusal.detail).join(" ")).toContain("needs a source no process holds");
        expect(existsSync(join(source, "sessions"))).toBe(true);
        expect(treeFingerprint(destination)).toBe(before);
    });

    test("--desktop refuses while the destination Desktop state is held open, and copies nothing rather than half of the job", async () => {
        const root = scratch();
        const destination = makeHome(root, ".codex", [], { "local-projects": {}, "project-order": [] });
        const source = makeHome(root, ".codex-alpha", [{ date: "2026-09-07", uuid: uuid("0035") }], {
            "local-projects": {},
            "project-order": [],
        });
        const before = treeFingerprint(destination);
        const stateHeld = (): OpenFilesResult => [
            { pid: 777, command: "Codex", path: join(destination, ".codex-global-state.json") },
        ];

        const report = await migrateHome({
            from: [source],
            to: destination,
            apply: true,
            desktop: true,
            backupRoot: join(root, "backups"),
            stamp: "s",
            inspectOpenFiles: stateHeld,
        });

        expect(report.applied).toBe(false);
        expect(report.refusals.map((refusal) => refusal.detail).join(" ")).toContain("Codex Desktop state");
        expect(treeFingerprint(destination)).toBe(before);
    });

    test("refuses when the open-file question cannot be answered at all", async () => {
        const root = scratch();
        const destination = makeHome(root, ".codex", []);
        const source = makeHome(root, ".codex-alpha", [{ date: "2026-09-07", uuid: uuid("0041") }]);
        const before = treeFingerprint(destination);

        const report = await migrateHome({
            from: [source],
            to: destination,
            apply: true,
            backupRoot: join(root, "backups"),
            stamp: "s",
            inspectOpenFiles: () => "unknown",
        });

        expect(report.applied).toBe(false);
        expect(report.busy.every((entry) => entry.status === "unknown")).toBe(true);
        expect(report.refusals.map((refusal) => refusal.detail).join(" ")).toContain("Could not determine");
        expect(treeFingerprint(destination)).toBe(before);
    });

    test("a dry run reports the plan and writes nothing", async () => {
        const root = scratch();
        const destination = makeHome(root, ".codex", [{ date: "2026-08-01", uuid: uuid("0051") }]);
        const source = makeHome(root, ".codex-alpha", [{ date: "2026-09-07", uuid: uuid("0052") }]);
        const destinationBefore = treeFingerprint(destination);
        const sourceBefore = treeFingerprint(source);

        const report = await migrateHome({
            from: [source],
            to: destination,
            backupRoot: join(root, "backups"),
            stamp: "s",
            inspectOpenFiles: clear,
        });

        expect(report.applied).toBe(false);
        expect(report.totals.toCopy).toBe(1);
        expect(report.refusals).toEqual([]);
        expect(treeFingerprint(destination)).toBe(destinationBefore);
        expect(treeFingerprint(source)).toBe(sourceBefore);
        expect(existsSync(join(root, "backups"))).toBe(false);
    });

    test("--archive-source renames the source sessions directory only after a verified copy", async () => {
        const root = scratch();
        const destination = makeHome(root, ".codex", []);
        const source = makeHome(root, ".codex-alpha", [{ date: "2026-09-07", uuid: uuid("0061") }]);

        const report = await migrateHome({
            from: [source],
            to: destination,
            apply: true,
            archiveSource: true,
            backupRoot: join(root, "backups"),
            stamp: "20260909-221500",
            inspectOpenFiles: clear,
        });

        expect(report.sources[0]?.archivedTo).toBe(join(source, "sessions.migrated-20260909-221500"));
        expect(existsSync(join(source, "sessions.migrated-20260909-221500"))).toBe(true);
        expect(existsSync(join(source, "sessions"))).toBe(false);
        expect(enumerateRollouts(join(destination, "sessions"))).toHaveLength(1);
    });
});

describe("discoverSourceHomes", () => {
    test("takes every sibling holding sessions, and skips backups, the destination and .codexbar", () => {
        const root = scratch();
        const destination = makeHome(root, ".codex", []);
        makeHome(root, ".codex-alpha", []);
        makeHome(root, ".codex-bak-2026-09-04", []);
        makeHome(root, ".codexbar", []);
        mkdirSync(join(root, ".codex-empty"), { recursive: true });

        expect(discoverSourceHomes(destination, root)).toEqual([join(root, ".codex-alpha")]);
    });
});

describe("mergeDesktopState", () => {
    const sourceProjectId = "57d8253c-2e5e-46dd-bdac-67bf7fc5960d";
    const destinationProjectId = "local-9cd1e0822df5875448f268d022268cdc";
    const threadId = "01a078d5-1f23-7f43-8eb0-5577909e39b3";
    const identity = (value: string): string => value;

    function fixture(): { destination: DesktopState; source: DesktopState } {
        return {
            destination: {
                "local-projects": {
                    [destinationProjectId]: {
                        id: destinationProjectId,
                        name: "notebook",
                        rootPaths: ["/Users/example/notebook"],
                    },
                },
                "project-order": [destinationProjectId],
                "thread-project-assignments": {},
                "selected-project": destinationProjectId,
            },
            source: {
                "local-projects": {
                    [sourceProjectId]: {
                        id: sourceProjectId,
                        name: "notebook",
                        rootPaths: ["/Users/example/notebook/"],
                    },
                },
                "project-order": [sourceProjectId],
                "thread-project-assignments": {
                    [threadId]: { projectKind: "local", projectId: sourceProjectId },
                },
                "selected-project": sourceProjectId,
            },
        };
    }

    test("one root path under two id schemes leaves exactly one project", () => {
        const { destination, source } = fixture();
        const { merged, report } = mergeDesktopState(destination, source, identity);

        // Merging by id instead of by root path is what this asserts against: that variant keeps
        // both ids, so the count is 2 and the assignment still points at the source id.
        expect(Object.keys(merged["local-projects"] ?? {})).toEqual([destinationProjectId]);
        expect(report.projectsAdded).toEqual([]);
        expect(report.duplicatesAvoided).toEqual([
            { rootPath: "/Users/example/notebook", sourceId: sourceProjectId, destinationId: destinationProjectId },
        ]);
        expect(merged["project-order"]).toEqual([destinationProjectId]);
        expect(merged["thread-project-assignments"]?.[threadId]?.projectId).toBe(destinationProjectId);
        expect(report.assignmentsRemapped).toBe(1);
    });

    test("a genuinely new root path is added once and appended to project-order", () => {
        const { destination, source } = fixture();
        source["local-projects"] = {
            [sourceProjectId]: { id: sourceProjectId, name: "Martin", rootPaths: ["/Users/example"] },
        };

        const first = mergeDesktopState(destination, source, identity);
        expect(first.report.projectsAdded).toHaveLength(1);
        expect(first.report.orderAppended).toEqual([sourceProjectId]);
        expect(first.merged["project-order"]).toEqual([destinationProjectId, sourceProjectId]);

        const second = mergeDesktopState(first.merged, source, identity);
        expect(second.report.projectsAdded).toEqual([]);
        expect(Object.keys(second.merged["local-projects"] ?? {})).toHaveLength(2);
    });

    test("the destination wins for a thread it already assigns, and selected-project is untouched", () => {
        const { destination, source } = fixture();
        destination["thread-project-assignments"] = {
            [threadId]: { projectKind: "local", projectId: destinationProjectId },
        };

        const { merged, report } = mergeDesktopState(destination, source, identity);

        expect(report.assignmentsKept).toBe(1);
        expect(report.assignmentsAdded).toBe(0);
        expect(merged["selected-project"]).toBe(destinationProjectId);
    });
});

describe("normaliseRootPath", () => {
    test("strips trailing separators", () => {
        expect(normaliseRootPath("/Users/example/x///", (value) => value)).toBe("/Users/example/x");
    });
});

describe("desktop merge through migrateHome", () => {
    test("--desktop writes the merged state atomically and only under --apply", async () => {
        const root = scratch();
        const destination = makeHome(root, ".codex", [], {
            "local-projects": {
                "local-aaa": { id: "local-aaa", name: "Project", rootPaths: [join(root, "project")] },
            },
            "project-order": ["local-aaa"],
            "thread-project-assignments": {},
        });
        const source = makeHome(root, ".codex-alpha", [{ date: "2026-09-07", uuid: uuid("0071") }], {
            "local-projects": {
                "uuid-bbb": { id: "uuid-bbb", name: "Project", rootPaths: [`${join(root, "project")}/`] },
                "uuid-ccc": { id: "uuid-ccc", name: "Other", rootPaths: [join(root, "other")] },
            },
            "project-order": ["uuid-bbb", "uuid-ccc"],
            "thread-project-assignments": {
                "thread-1": { projectKind: "local", projectId: "uuid-bbb" },
                "thread-2": { projectKind: "local", projectId: "uuid-ccc" },
            },
        });
        mkdirSync(join(root, "project"), { recursive: true });
        mkdirSync(join(root, "other"), { recursive: true });

        const statePath = join(destination, ".codex-global-state.json");
        const before = readFileSync(statePath, "utf8");

        const dry = await migrateHome({
            from: [source],
            to: destination,
            desktop: true,
            backupRoot: join(root, "backups"),
            stamp: "s",
            inspectOpenFiles: clear,
        });
        expect(dry.desktop).toEqual([]);
        expect(readFileSync(statePath, "utf8")).toBe(before);

        const applied = await migrateHome({
            from: [source],
            to: destination,
            apply: true,
            desktop: true,
            backupRoot: join(root, "backups"),
            stamp: "s2",
            inspectOpenFiles: clear,
        });

        expect(applied.desktop[0]?.written).toBe(true);
        expect(applied.desktop[0]?.duplicatesAvoided).toHaveLength(1);
        expect(applied.desktop[0]?.projectsAdded.map((project) => project.id)).toEqual(["uuid-ccc"]);

        const merged = SafeJSON.parse(readFileSync(statePath, "utf8")) as DesktopState;
        expect(Object.keys(merged["local-projects"] ?? {}).sort()).toEqual(["local-aaa", "uuid-ccc"]);
        expect(merged["project-order"]).toEqual(["local-aaa", "uuid-ccc"]);
        expect(merged["thread-project-assignments"]?.["thread-1"]?.projectId).toBe("local-aaa");
        expect(merged["thread-project-assignments"]?.["thread-2"]?.projectId).toBe("uuid-ccc");
        expect(readdirSync(destination).filter((name) => name.includes(".tmp"))).toEqual([]);
        expect(applied.backups.globalState).toBe(join(root, "backups", "s2", ".codex-global-state.json"));
    });
});

describe("migrateHome with an unusable --from entry", () => {
    test("a named home with no sessions/ is skipped, and the usable one still migrates", async () => {
        // `--from a,b` where `b` was never a Codex home (a typo, a home already archived by an
        // earlier `--archive-source` run) used to push a refusal, and any refusal blocks the
        // whole run — so every rollout in `a` was planned and none was copied.
        const root = scratch();
        const destination = makeHome(root, ".codex", []);
        const alpha = makeHome(root, ".codex-alpha", [{ date: "2026-09-07", uuid: uuid("0011") }]);
        const bare = join(root, ".codex-bare");
        mkdirSync(bare, { recursive: true });

        const report = await migrateHome({
            from: [alpha, bare, destination],
            to: destination,
            apply: true,
            backupRoot: join(root, "backups"),
            stamp: "20260910-000000",
            inspectOpenFiles: clear,
        });

        expect(report.refusals).toEqual([]);
        expect(report.applied).toBe(true);
        expect(report.totals).toMatchObject({ toCopy: 1, copied: 1 });
        expect(report.skippedSources.map((entry) => entry.home).sort()).toEqual([bare, destination].sort());
        expect(enumerateRollouts(join(destination, "sessions"))).toHaveLength(1);
    });

    test("negative control: with no usable source at all the run still refuses", async () => {
        const root = scratch();
        const destination = makeHome(root, ".codex", []);
        const bare = join(root, ".codex-bare");
        mkdirSync(bare, { recursive: true });

        const report = await migrateHome({
            from: [bare],
            to: destination,
            apply: true,
            backupRoot: join(root, "backups"),
            inspectOpenFiles: clear,
        });

        expect(report.applied).toBe(false);
        expect(report.refusals.map((refusal) => refusal.reason)).toEqual(["no-sources"]);
        expect(report.skippedSources).toHaveLength(1);
    });
});

describe("mergeDesktopState with a colliding project id", () => {
    test("a source project that reuses a destination id gets its own entry, not the destination's", async () => {
        // `cp -R ~/.codex ~/.codex-work` duplicates every project id, and the two homes then
        // diverge as project roots are renamed. Writing the source project under the shared id
        // replaced the destination's project and left every destination thread assigned to that
        // id pointing at the source's directory, reported as `projectsAdded` with no warning.
        const destination: DesktopState = {
            "local-projects": { shared: { id: "shared", name: "dest-project", rootPaths: ["/work/dest"] } },
            "project-order": ["shared"],
            "thread-project-assignments": { "thread-d": { projectKind: "local", projectId: "shared" } },
        };
        const source: DesktopState = {
            "local-projects": { shared: { id: "shared", name: "source-project", rootPaths: ["/work/source"] } },
            "project-order": ["shared"],
            "thread-project-assignments": { "thread-s": { projectKind: "local", projectId: "shared" } },
        };

        const { merged, report } = mergeDesktopState(destination, source, (value) => value);
        const projects = merged["local-projects"] ?? {};

        expect(projects.shared).toMatchObject({ name: "dest-project", rootPaths: ["/work/dest"] });
        expect(report.projectsAdded).toHaveLength(1);

        const mintedId = report.projectsAdded[0].id;
        expect(mintedId).not.toBe("shared");
        expect(projects[mintedId]).toMatchObject({ id: mintedId, name: "source-project", rootPaths: ["/work/source"] });
        expect(merged["project-order"]).toEqual(["shared", mintedId]);
        // The destination's own thread keeps its project; the source's follows the new id.
        expect(merged["thread-project-assignments"]?.["thread-d"]?.projectId).toBe("shared");
        expect(merged["thread-project-assignments"]?.["thread-s"]?.projectId).toBe(mintedId);
    });

    test("negative control: the same id for the same root path still merges as one project", async () => {
        const destination: DesktopState = {
            "local-projects": { shared: { id: "shared", name: "dest-project", rootPaths: ["/work/same"] } },
            "project-order": ["shared"],
        };
        const source: DesktopState = {
            "local-projects": { shared: { id: "shared", name: "source-project", rootPaths: ["/work/same"] } },
            "thread-project-assignments": { "thread-s": { projectKind: "local", projectId: "shared" } },
        };

        const { merged, report } = mergeDesktopState(destination, source, (value) => value);

        expect(report.projectsAdded).toEqual([]);
        expect(report.duplicatesAvoided).toHaveLength(1);
        expect(Object.keys(merged["local-projects"] ?? {})).toEqual(["shared"]);
        expect(merged["thread-project-assignments"]?.["thread-s"]?.projectId).toBe("shared");
    });
});
