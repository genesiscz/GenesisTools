import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanPackageCacheAction, DevCachesAnalyzer } from "@app/doctor/analyzers/dev-caches";
import { DiskSpaceAnalyzer } from "@app/doctor/analyzers/disk-space";
import { type ActDeps, type ActOptions, pathsHash, runAct } from "@app/doctor/lib/act";
import { Analyzer } from "@app/doctor/lib/analyzer";
import { runOne } from "@app/doctor/lib/executor";
import * as packages from "@app/doctor/lib/global-packages";
import { removePathsAction } from "@app/doctor/lib/remove-action";
import * as commands from "@app/doctor/lib/run";
import { evaluateScanGate } from "@app/doctor/lib/scan-gate";
import * as sizes from "@app/doctor/lib/size";
import { moveToTrash } from "@app/doctor/lib/trash";
import type { Action, ActionResult, AnalyzerCategory, ConfirmMode, Finding, Severity } from "@app/doctor/lib/types";
import {
    byKeys,
    type ContractShapeOptions,
    contractShapeMismatches,
    ndjsonShapeMismatches,
    readKitFixtureJson,
    readKitFixtureLines,
} from "@app/macos/lib/kit-fixtures";
import { SafeJSON } from "@genesiscz/utils/json";

const base = realpathSync(mkdtempSync(join(tmpdir(), "doctor-act-")));

afterAll(() => {
    rmSync(base, { recursive: true, force: true });
});

interface Spec {
    id: string;
    paths: string[];
    severity?: Severity;
    confirm?: ConfirmMode;
    phrase?: string;
    blockers?: string[];
    bytes?: number;
    reclaimable?: number;
    action?: Partial<Action>;
}

class FixtureAnalyzer extends Analyzer {
    readonly id = "fixture";
    readonly name = "Fixture";
    readonly icon = "F";
    readonly category: AnalyzerCategory = "disk";
    rechecks = 0;

    constructor(
        private readonly roots: string[],
        private readonly home: string,
        private readonly specs: () => Spec[]
    ) {
        super();
    }

    override allowRoots(): string[] {
        return this.roots;
    }

    protected async *run(): AsyncIterable<Finding> {
        for (const spec of this.specs()) {
            if (spec.paths.every((path) => existsSync(path))) {
                yield this.build(spec);
            }
        }
    }

    override async recheck(ids: string[], ctx: Parameters<Analyzer["recheck"]>[1]): Promise<Finding[]> {
        this.rechecks += 1;
        return super.recheck(ids, ctx);
    }

    private build(spec: Spec): Finding {
        const remover = removePathsAction({
            id: "delete-thing",
            label: "Delete",
            confirm: spec.confirm ?? "yesno",
            ...(spec.phrase ? { confirmPhrase: spec.phrase } : {}),
            analyzerId: this.id,
            home: this.home,
            allowRoots: () => this.roots,
        });

        return {
            id: spec.id,
            analyzerId: this.id,
            title: spec.id,
            severity: spec.severity ?? "cautious",
            reclaimableBytes: spec.reclaimable ?? spec.bytes ?? 4096,
            ...(spec.severity === "blocked" ? { blacklistReason: "a VM disk" } : {}),
            actions: spec.severity === "blocked" ? [] : [{ ...remover, ...spec.action }],
            metadata: {
                kind: "fixture",
                paths: spec.paths,
                allocatedBytes: spec.bytes ?? 4096,
                ...(spec.blockers ? { blockers: spec.blockers } : {}),
            },
        };
    }
}

let dir: string;
let home: string;
let allowed: string;
let outside: string;
let history: ActionResult[];

function deps(analyzer: Analyzer, extra: Partial<ActDeps> = {}): ActDeps {
    return {
        analyzers: [analyzer],
        manifestsDir: join(dir, "manifests"),
        lockPath: join(dir, "state", "act.lock"),
        home,
        statfs: () => ({ available: 1_000_000, total: 10_000_000 }),
        appendHistory: async (_runId, result) => {
            history.push(result);
        },
        remove: async () => {
            throw new Error("remove must not be reached");
        },
        trash: async () => {
            throw new Error("trash must not be reached");
        },
        ...extra,
    };
}

function opts(ids: string[], extra: Partial<ActOptions> = {}): ActOptions {
    return {
        actionId: "delete-thing",
        analyzerId: "fixture",
        ids,
        method: "delete",
        yes: true,
        confirm: [],
        dryRun: false,
        argv: ["doctor", "act", "delete-thing"],
        ...extra,
    };
}

/**
 * An act item's keys depend on its status and refusal reason, so each is checked against the contract item of its
 * kind.
 */
const ACT_SHAPE: ContractShapeOptions = { kinds: { "$.items[]": byKeys("status", "reason") } };

/** The `--json` result has the keys and nesting of the kit's contract fixture `contract-<name>.json`. */
function expectActContract(result: unknown, name: string): void {
    expect(contractShapeMismatches(result, readKitFixtureJson(`contract-${name}.json`), ACT_SHAPE)).toEqual([]);
}

function folder(path: string): string {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "data.bin"), Buffer.alloc(4096, 1));
    return path;
}

const realRemove = async (path: string): Promise<void> => {
    rmSync(path, { recursive: true, force: false });
};

beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(base, "case-")));
    home = join(dir, "home");
    allowed = join(home, "Library", "Caches");
    outside = join(dir, "outside");
    mkdirSync(allowed, { recursive: true });
    mkdirSync(outside, { recursive: true });
    history = [];
});

describe("doctor act guards", () => {
    it.each(["delete", "trash"] as const)("guards each path again during a multi-path %s", async (method) => {
        for (const changed of ["git", "link", "busy"] as const) {
            const first = folder(join(allowed, `first-${method}-${changed}`));
            const second = folder(join(allowed, `second-${method}-${changed}`));
            const analyzer = new FixtureAnalyzer([allowed], home, () => [{ id: "f:batch", paths: [first, second] }]);
            const consumed: string[] = [];
            let busy = false;
            const consume = async (path: string) => {
                consumed.push(path);
                if (path !== first) {
                    throw new Error("unsafe second path consumed");
                }
                if (changed === "git") {
                    mkdirSync(join(second, ".git"));
                }
                if (changed === "link") {
                    rmSync(second, { recursive: true });
                    symlinkSync(outside, second);
                }
                busy = changed === "busy";
            };
            const result = await runAct(
                opts(["f:batch"], { method }),
                deps(analyzer, {
                    processes: async () => [{ pid: 424242, command: "fixture-worker", startedAt: null }],
                    cwds: () => (busy ? new Map([[424242, second]]) : new Map()),
                    remove: consume,
                    trash: async (path) => {
                        await consume(path);
                        return { ok: true, trashPath: `${path}.trash` };
                    },
                })
            );
            expect(result.exitCode).toBe(1);
            expect(consumed).toEqual([first]);
            expect(result.result.items[0].error).toContain("Refusing removal");
        }
    });

    it("guards package-cache commands at rm and still permits a normal cache", async () => {
        const context = {
            runId: "fixture-cache",
            opts: { thorough: false, fresh: true, dryRun: false },
            emit: () => {},
        };
        const snapshot = spyOn(packages, "writeSnapshot").mockResolvedValue(undefined);
        const remove = spyOn(fsPromises, "rm").mockImplementation(async () => {
            throw new Error("unsafe rm reached");
        });
        try {
            for (const mode of ["git", "parent-link", "normal"]) {
                const fixtureHome = join(home, mode);
                const bun = join(fixtureHome, ".bun");
                const cache = join(bun, "install", "cache");
                if (mode === "parent-link") {
                    mkdirSync(fixtureHome, { recursive: true });
                    mkdirSync(join(outside, "install", "cache"), { recursive: true });
                    symlinkSync(outside, bun);
                } else {
                    folder(cache);
                }
                if (mode === "git") {
                    mkdirSync(join(cache, ".git"));
                }
                const action = cleanPackageCacheAction({
                    ctx: context,
                    home: fixtureHome,
                    manager: "bun",
                    path: cache,
                    bytes: 4096,
                    globals: [],
                    cmd: { cmd: "bun", args: [] },
                });
                const finding: Finding = {
                    id: "cache",
                    analyzerId: "dev-caches",
                    title: "Fixture",
                    severity: "cautious",
                    actions: [action],
                };
                remove.mockClear();
                if (mode === "normal") {
                    remove.mockResolvedValue(undefined);
                }
                const result = await action.execute({ runId: "fixture-cache", dryRun: false }, finding);
                expect(result.status).toBe(mode === "normal" ? "ok" : "failed");
                expect(remove.mock.calls.length).toBe(mode === "normal" ? 1 : 0);
            }
            expect(snapshot.mock.calls.length).toBe(3);
        } finally {
            snapshot.mockRestore();
            remove.mockRestore();
        }
    });

    it("runs actable brew and docker commands through captured bounded execution", async () => {
        const cache = folder(join(allowed, "brew"));
        const run = spyOn(commands, "run").mockImplementation(async (cmd, args = []) => ({
            status: 0,
            timedOut: false,
            stderr: "diagnostic",
            stdout:
                cmd === "brew" && args[0] === "--cache"
                    ? cache
                    : args[0] === "context"
                      ? "fixture"
                      : args.includes("df")
                        ? '{"Type":"Images","TotalCount":"2","Active":"1","Size":"1GB","Reclaimable":"1GB"}'
                        : "human cleanup output",
        }));
        const inherit = spyOn(commands, "runInherit").mockImplementation(async () => {
            throw new Error("inherited stdout reached");
        });
        const size = spyOn(sizes, "duBytes").mockResolvedValue(300 * 1024 ** 2);
        try {
            const analyzer = new DevCachesAnalyzer({ home, roots: [] });
            const findings = await analyzer.recheck(["dev-brew-cache", "dev-docker-unused-images:fixture"], {
                runId: "fixture",
                opts: { thorough: false, fresh: true, dryRun: false },
                emit: () => {},
            });
            expect(findings.length).toBe(2);
            for (const finding of findings) {
                const result = await finding.actions[0].execute({ runId: "fixture", dryRun: false }, finding);
                expect(result.status).toBe("ok");
            }
            const cleanup = run.mock.calls.filter(([, args]) => args?.includes("cleanup") || args?.includes("prune"));
            expect(cleanup.length).toBe(2);
            expect(cleanup.every((call) => call[2]?.timeoutMs === 120_000)).toBe(true);
            expect(inherit).not.toHaveBeenCalled();
        } finally {
            run.mockRestore();
            inherit.mockRestore();
            size.mockRestore();
        }
    });

    it("refuses a blocked finding with its reason and never reaches the remover", async () => {
        const target = folder(join(allowed, "vm"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [
            { id: "f:vm", paths: [target], severity: "blocked" },
        ]);
        const run = await runAct(opts(["f:vm"]), deps(analyzer));

        expect(run.exitCode).toBe(1);
        expect(run.result.items[0]).toMatchObject({
            status: "refused",
            reason: "blocked",
            blacklistReason: "a VM disk",
        });
        expect(existsSync(target)).toBe(true);
    });

    it("re-derives a finding instead of trusting a cached one that lost its execute", async () => {
        const target = folder(join(allowed, "cache-a"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [{ id: "f:a", paths: [target] }]);
        const [live] = await analyzer.recheck(["f:a"], {
            runId: "x",
            opts: { thorough: false, fresh: true, dryRun: true },
            emit: () => {},
        });
        const cached = SafeJSON.parse(SafeJSON.stringify(live), { strict: true }) as Finding;
        const cachedRun = await runOne({ runId: "x", dryRun: false }, cached, cached.actions[0] as Action);

        expect(cachedRun.status).toBe("failed");
        expect(cachedRun.error).toContain("--fresh");

        analyzer.rechecks = 0;
        const run = await runAct(opts(["f:a"]), deps(analyzer, { remove: realRemove }));

        expect(analyzer.rechecks).toBe(1);
        expect(run.result.items[0]?.status).toBe("ok");
        expect(existsSync(target)).toBe(false);
    });

    it("refuses a yes/no action without --yes", async () => {
        const target = folder(join(allowed, "cache-b"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [{ id: "f:b", paths: [target] }]);
        const run = await runAct(opts(["f:b"], { yes: false }), deps(analyzer));

        expect(run.result.items[0]).toMatchObject({
            status: "refused",
            reason: "confirm-required",
            requiredConfirm: "yesno",
        });
        expect(existsSync(target)).toBe(true);
    });

    it("refuses a wrong typed phrase and echoes the expected one; a dangerous finding always needs it", async () => {
        const typed = folder(join(allowed, "typed"));
        const danger = folder(join(allowed, "danger"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [
            { id: "f:typed", paths: [typed], confirm: "typed", phrase: "yes, delete" },
            { id: "f:danger", paths: [danger], severity: "dangerous" },
        ]);
        const run = await runAct(opts(["f:typed", "f:danger"], { confirm: ["yes delete"] }), deps(analyzer));

        expect(run.result.items).toEqual([
            expect.objectContaining({
                findingId: "f:typed",
                reason: "confirm-required",
                expectedPhrase: "yes, delete",
            }),
            expect.objectContaining({ findingId: "f:danger", reason: "confirm-required", expectedPhrase: "DELETE" }),
        ]);
        expect(existsSync(typed) && existsSync(danger)).toBe(true);
    });

    it("refuses a path outside the analyzer's allow roots", async () => {
        const target = folder(join(outside, "documents"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [{ id: "f:out", paths: [target] }]);
        const run = await runAct(opts(["f:out"]), deps(analyzer));

        expect(run.result.items[0]).toMatchObject({ status: "refused", reason: "outside-allowlist" });
        expect(existsSync(target)).toBe(true);
    });

    it("refuses a symlink inside the root that points outside it", async () => {
        const victim = folder(join(outside, "victim"));
        const link = join(allowed, "innocent-cache");
        symlinkSync(victim, link);
        const analyzer = new FixtureAnalyzer([allowed], home, () => [{ id: "f:link", paths: [link] }]);
        const run = await runAct(opts(["f:link"]), deps(analyzer));

        expect(run.result.items[0]).toMatchObject({ status: "refused", reason: "outside-allowlist" });
        expect(run.result.items[0]?.error).toContain("symbolic link");
        expect(existsSync(join(victim, "data.bin"))).toBe(true);
    });

    it("refuses VM disks by name even inside an allow root", async () => {
        const target = join(allowed, "Docker.raw");
        writeFileSync(target, "x");
        const analyzer = new FixtureAnalyzer([allowed], home, () => [{ id: "f:raw", paths: [target] }]);
        const run = await runAct(opts(["f:raw"]), deps(analyzer));

        expect(run.result.items[0]).toMatchObject({ reason: "outside-allowlist" });
        expect(existsSync(target)).toBe(true);
    });

    it("refuses method, kind, in-use and stale problems, and a finding that is gone", async () => {
        const a = folder(join(allowed, "a"));
        const b = folder(join(allowed, "b"));
        const c = folder(join(allowed, "c"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [
            { id: "f:busy", paths: [a], blockers: ["Example is running (pid 7): quit it first"] },
            { id: "f:grew", paths: [b], bytes: 10_000 },
            { id: "f:reveal", paths: [c], action: { kind: undefined } },
        ]);
        const run = await runAct(
            opts(["f:busy", "f:grew", "f:reveal", "f:gone"], { expect: new Map([["f:grew", 4_000]]) }),
            deps(analyzer)
        );
        const reasons = Object.fromEntries(run.result.items.map((item) => [item.findingId, item.reason]));

        expect(reasons).toEqual({
            "f:busy": "in-use",
            "f:grew": "stale",
            "f:reveal": "category-not-allowed",
            "f:gone": "not-found",
        });

        const noMethod = await runAct(opts(["f:busy"], { method: undefined }), deps(analyzer));
        expect(noMethod.result.items[0]?.reason).toBe("method-required");
    });
});

describe("doctor act order of work", () => {
    it("writes and fsyncs the manifest plan before the first delete, then logs each item", async () => {
        const target = folder(join(allowed, "ms-playwright"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [
            { id: "f:pw", paths: [target], bytes: 891_289_600 },
        ]);
        let manifestAtDelete: string[] | null = null;
        const run = await runAct(
            opts(["f:pw"]),
            deps(analyzer, {
                remove: async (path) => {
                    const manifests = join(dir, "manifests");
                    const files = existsSync(manifests) ? readdirSync(manifests) : [];

                    if (files.length === 0) {
                        throw new Error("no manifest before the delete");
                    }

                    manifestAtDelete = readFileSync(join(manifests, files[0] as string), "utf8")
                        .trim()
                        .split("\n");
                    await realRemove(path);
                },
            })
        );

        expect(run.exitCode).toBe(0);
        expect(manifestAtDelete).not.toBeNull();
        const atDelete = (manifestAtDelete ?? []).map(
            (line) => SafeJSON.parse(line, { strict: true }) as { type: string }
        );
        expect(atDelete.map((e) => e.type)).toEqual(["plan", "item-start"]);
        const finalLines = readFileSync(run.result.manifestPath as string, "utf8")
            .trim()
            .split("\n");
        expect(finalLines.map((line) => (SafeJSON.parse(line, { strict: true }) as { type: string }).type)).toEqual([
            "plan",
            "item-start",
            "item-done",
            "volume-after",
        ]);
        expect(history.map((h) => h.status)).toEqual(["ok"]);
        expect(existsSync(target)).toBe(false);
    });

    it("a Trash move is staged, frees nothing now, is logged, and names where it went", async () => {
        const target = folder(join(allowed, "old-cache"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [{ id: "f:trash", paths: [target] }]);
        const run = await runAct(
            opts(["f:trash"], { method: "trash" }),
            deps(analyzer, { trash: async () => ({ ok: true, trashPath: join(home, ".Trash", "old-cache") }) })
        );

        expect(run.exitCode).toBe(0);
        expect(run.result.items[0]).toMatchObject({
            status: "staged",
            freesNow: "no",
            trashPaths: [join(home, ".Trash", "old-cache")],
            restore: "Finder: Put Back from the Trash",
        });
        expect(run.result.volume.settleNote).toContain("Trash");
        expect(history.map((h) => [h.status, h.metadata?.method])).toEqual([["staged", "trash"]]);
    });

    it("a second act while one runs is refused on the lock", async () => {
        const first = folder(join(allowed, "first"));
        const second = folder(join(allowed, "second"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [
            { id: "f:1", paths: [first] },
            { id: "f:2", paths: [second] },
        ]);
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered: () => void = () => {};
        const inside = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const slow = runAct(
            opts(["f:1"]),
            deps(analyzer, {
                remove: async (path) => {
                    entered();
                    await gate;
                    await realRemove(path);
                },
            })
        );
        await inside;
        const blocked = await runAct(opts(["f:2"]), deps(analyzer, { remove: realRemove }));
        release();
        const done = await slow;

        expect(blocked.result.items[0]).toMatchObject({ status: "refused", reason: "locked" });
        expect(blocked.exitCode).toBe(1);
        expect(existsSync(second)).toBe(true);
        expect(done.result.items[0]?.status).toBe("ok");
    });

    it("a dry run re-checks and plans, and writes nothing", async () => {
        const target = folder(join(allowed, "dry"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [{ id: "f:dry", paths: [target] }]);
        const run = await runAct(opts(["f:dry"], { dryRun: true }), deps(analyzer));

        expect(run.exitCode).toBe(0);
        expect(run.result).toMatchObject({ dryRun: true, manifestPath: null });
        expect(run.result.items[0]).toMatchObject({ status: "skipped", freesNow: "no" });
        expect(existsSync(join(dir, "manifests"))).toBe(false);
        expect(existsSync(join(dir, "state"))).toBe(false);
        expect(history).toEqual([]);
        expect(existsSync(target)).toBe(true);
        expectActContract(run.result, "doctor-act-dryrun");
    });

    it("the result object keeps the frozen contract's fields", async () => {
        const target = folder(join(allowed, "contract"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [{ id: "f:c", paths: [target] }]);
        const run = await runAct(opts(["f:c"]), deps(analyzer, { remove: realRemove }));

        expect(run.result.items[0]?.status).toBe("ok");
        expectActContract(run.result, "doctor-act-result-ok");
    });

    it("a refused run keeps the frozen contract's fields for blocked, unconfirmed and outside items", async () => {
        const vm = folder(join(allowed, "vm-disk"));
        const typed = folder(join(allowed, "session"));
        const victim = folder(join(outside, "reports"));
        const link = join(allowed, "linked-session");
        symlinkSync(victim, link);
        const analyzer = new FixtureAnalyzer([allowed], home, () => [
            { id: "f:vm", paths: [vm], severity: "blocked" },
            { id: "f:typed", paths: [typed], confirm: "typed", phrase: "DELETE" },
            { id: "f:link", paths: [link] },
        ]);
        const run = await runAct(opts(["f:vm", "f:typed", "f:link"]), deps(analyzer));

        expect(run.result.items.map((item) => item.reason)).toEqual([
            "blocked",
            "confirm-required",
            "outside-allowlist",
        ]);
        expectActContract(run.result, "doctor-act-result-refused");
    });

    it("the --ndjson stream keeps the frozen contract's events for a Trash move", async () => {
        const target = folder(join(allowed, "stream-cache"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [{ id: "f:stream", paths: [target] }]);
        const events: unknown[] = [];
        await runAct(
            opts(["f:stream"], { method: "trash" }),
            deps(analyzer, {
                trash: async () => ({ ok: true, trashPath: join(home, ".Trash", "stream-cache") }),
                onEvent: (event) => events.push(event),
            })
        );

        expect(events.map(byKeys("type"))).toEqual(["plan", "item-start", "item-done", "volume-after", "result"]);
        expect(
            ndjsonShapeMismatches(events, readKitFixtureLines("contract-doctor-act.ndjson"), {
                kinds: { "$.result.items[]": byKeys("status", "reason") },
            })
        ).toEqual([]);
    });
});

const OPEN_GATE = async () => evaluateScanGate({ availableBytes: 50 * 1024 ** 3, fseventsdRssBytes: 1024 ** 2 });
const CLOSED_GATE = async () => evaluateScanGate({ availableBytes: 100 * 1024 ** 2, fseventsdRssBytes: 1024 ** 2 });

function realDeps(analyzer: Analyzer, extra: Partial<ActDeps> = {}): ActDeps {
    return {
        ...deps(analyzer, extra),
        processes: async () => [{ pid: 1, command: "/sbin/launchd", startedAt: null }],
        cwds: () => new Map(),
        ...extra,
    };
}

describe("doctor act never derives a path from an id (real analyzers)", () => {
    it("dev-caches: a crafted node_modules id naming a whole repository is not-found; the scanned one passes", async () => {
        const devroot = join(dir, "devroot");
        folder(join(devroot, "MyRepo"));
        folder(join(devroot, "App", "node_modules", "dep"));
        const analyzer = new DevCachesAnalyzer({ home, roots: [devroot], gate: OPEN_GATE, nodeModulesMinBytes: 1 });
        const crafted = `dev-node-modules-${join(devroot, "MyRepo")}`;
        const real = `dev-node-modules-${join(devroot, "App", "node_modules")}`;
        const run = await runAct(
            opts([crafted, real], { actionId: "delete-node-modules", analyzerId: "dev-caches", dryRun: true }),
            realDeps(analyzer)
        );
        const byId = Object.fromEntries(run.result.items.map((item) => [item.findingId, item]));

        expect(byId[crafted]).toMatchObject({ status: "refused", reason: "not-found", paths: [] });
        expect(byId[real]).toMatchObject({ status: "skipped", paths: [join(devroot, "App", "node_modules")] });
    });

    it("disk-space: a crafted large-file id the scan does not list (too deep, or the gate is closed) is not-found", async () => {
        const deep = join(home, "a", "b", "c", "d", "e", "f", "g", "movie.mov");
        mkdirSync(join(deep, ".."), { recursive: true });
        writeFileSync(deep, Buffer.alloc(3 * 1024 * 1024, 1));
        const shallow = join(home, "export.mov");
        writeFileSync(shallow, Buffer.alloc(3 * 1024 * 1024, 1));
        const open = new DiskSpaceAnalyzer({ home, gate: OPEN_GATE, largeFileMinBytes: 2 * 1024 * 1024 });
        const closed = new DiskSpaceAnalyzer({ home, gate: CLOSED_GATE, largeFileMinBytes: 2 * 1024 * 1024 });
        const act = { actionId: "direct-delete", analyzerId: "disk-space", dryRun: true, confirm: ["yes, delete"] };

        const deepRun = await runAct(opts([`disk-large-${deep}`], act), realDeps(open));
        const gatedRun = await runAct(opts([`disk-large-${shallow}`], act), realDeps(closed));
        const listedRun = await runAct(opts([`disk-large-${shallow}`], act), realDeps(open));

        expect(deepRun.result.items[0]).toMatchObject({ reason: "not-found" });
        expect(gatedRun.result.items[0]).toMatchObject({ reason: "not-found" });
        expect(listedRun.result.items[0]).toMatchObject({ status: "skipped", paths: [shallow] });
    });

    it("disk-space: moving a large user file to the Trash needs the typed phrase, never nothing", async () => {
        const file = join(home, "wedding.mov");
        writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 1));
        const analyzer = new DiskSpaceAnalyzer({ home, gate: OPEN_GATE, largeFileMinBytes: 2 * 1024 * 1024 });
        const run = await runAct(
            opts([`disk-large-${file}`], {
                actionId: "stage-trash",
                analyzerId: "disk-space",
                method: "trash",
                yes: true,
            }),
            realDeps(analyzer)
        );

        expect(run.result.items[0]).toMatchObject({
            status: "refused",
            reason: "confirm-required",
            requiredConfirm: "typed",
        });
        expect(existsSync(file)).toBe(true);
    });
});

describe("doctor act and symlinks", () => {
    for (const method of ["delete", "trash"] as const) {
        it(`--method ${method} refuses a symlink even when its target is inside the allow root`, async () => {
            const target = folder(join(allowed, "real-target"));
            const link = join(allowed, "link-to-target");
            symlinkSync(target, link);
            const touched: string[] = [];
            const analyzer = new FixtureAnalyzer([allowed], home, () => [{ id: "f:link", paths: [link] }]);
            const run = await runAct(
                opts(["f:link"], { method }),
                realDeps(analyzer, {
                    remove: async (path) => {
                        touched.push(path);
                    },
                    trash: async (path) => {
                        touched.push(path);
                        return { ok: true, trashPath: null };
                    },
                })
            );

            expect(run.result.items[0]).toMatchObject({ status: "refused", reason: "outside-allowlist" });
            expect(run.result.items[0]?.error).toContain("symbolic link");
            expect(touched).toEqual([]);
            expect(existsSync(join(target, "data.bin"))).toBe(true);
        });
    }

    it("the real Trash mover refuses a symlink before Finder can resolve it", async () => {
        const target = folder(join(allowed, "finder-target"));
        const link = join(allowed, "finder-link");
        symlinkSync(target, link);
        const moved = await moveToTrash(link);

        expect(moved).toMatchObject({ ok: false });
        expect(existsSync(join(target, "data.bin"))).toBe(true);
        expect(existsSync(link)).toBe(true);
    });
});

describe("doctor act re-checks at removal time", () => {
    it("takes the lock before re-deriving, so a second run never re-checks while one runs", async () => {
        const first = folder(join(allowed, "lock-first"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [{ id: "f:1", paths: [first] }]);
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered: () => void = () => {};
        const inside = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const slow = runAct(
            opts(["f:1"]),
            realDeps(analyzer, {
                remove: async (path) => {
                    entered();
                    await gate;
                    await realRemove(path);
                },
            })
        );
        await inside;
        analyzer.rechecks = 0;
        const blocked = await runAct(opts(["f:1"]), realDeps(analyzer));
        release();
        await slow;

        expect(blocked.result.items[0]).toMatchObject({ status: "refused", reason: "locked" });
        expect(analyzer.rechecks).toBe(0);
    });

    it("refuses a later item whose path turned into a symlink after the first guard", async () => {
        const first = folder(join(allowed, "first-item"));
        const second = folder(join(allowed, "second-item"));
        const elsewhere = folder(join(outside, "elsewhere"));
        const trashed: string[] = [];
        const analyzer = new FixtureAnalyzer([allowed], home, () => [
            { id: "f:1", paths: [first] },
            { id: "f:2", paths: [second] },
        ]);
        const run = await runAct(
            opts(["f:1", "f:2"], { method: "trash" }),
            realDeps(analyzer, {
                trash: async (path) => {
                    trashed.push(path);

                    if (path === first) {
                        rmSync(second, { recursive: true, force: true });
                        symlinkSync(elsewhere, second);
                    }

                    return { ok: true, trashPath: null };
                },
            })
        );

        expect(trashed).toEqual([first]);
        expect(run.result.items[1]).toMatchObject({ status: "refused", reason: "outside-allowlist" });
        expect(run.result.items[1]?.error).toContain("symbolic link");
        expect(existsSync(join(elsewhere, "data.bin"))).toBe(true);
    });

    it("refuses a path a process works inside, and a git checkout root", async () => {
        const busy = folder(join(allowed, "busy"));
        const repo = folder(join(allowed, "checkout"));
        writeFileSync(join(repo, ".git"), "gitdir: /elsewhere\n");
        const analyzer = new FixtureAnalyzer([allowed], home, () => [
            { id: "f:busy", paths: [busy] },
            { id: "f:repo", paths: [repo] },
        ]);
        const run = await runAct(
            opts(["f:busy", "f:repo"], { dryRun: true }),
            realDeps(analyzer, {
                processes: async () => [{ pid: 4242, command: "/usr/bin/vim notes", startedAt: null }],
                cwds: () => new Map([[4242, join(busy, "sub")]]),
            })
        );
        const byId = Object.fromEntries(run.result.items.map((item) => [item.findingId, item]));

        expect(byId["f:busy"]).toMatchObject({ reason: "in-use" });
        expect(byId["f:repo"]).toMatchObject({ reason: "outside-allowlist" });
        expect(byId["f:repo"]?.error).toContain("git");
    });

    it("refuses every removal when the process list cannot be read", async () => {
        const target = folder(join(allowed, "no-ps"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [{ id: "f:x", paths: [target] }]);
        const run = await runAct(
            opts(["f:x"], { dryRun: true }),
            realDeps(analyzer, {
                processes: async () => {
                    throw new Error("ps timed out");
                },
            })
        );

        expect(run.result.items[0]).toMatchObject({ reason: "in-use" });
        expect(run.result.items[0]?.blockers?.join(" ")).toContain("process list");
    });
});

describe("doctor act stale and log failures", () => {
    it("--expect compares with the shown reclaimable bytes, and --expect-paths refuses a changed set", async () => {
        const a = folder(join(allowed, "expect-a"));
        const b = folder(join(allowed, "expect-b"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [
            { id: "f:shown", paths: [a], bytes: 3000, reclaimable: 1000 },
            { id: "f:grown", paths: [b] },
        ]);
        const run = await runAct(
            opts(["f:shown", "f:grown"], {
                dryRun: true,
                expect: new Map([["f:shown", 1000]]),
                expectPaths: new Map([["f:grown", pathsHash([join(allowed, "something-else")])]]),
            }),
            realDeps(analyzer)
        );
        const byId = Object.fromEntries(run.result.items.map((item) => [item.findingId, item]));

        expect(byId["f:shown"]).toMatchObject({ status: "skipped" });
        expect(byId["f:grown"]).toMatchObject({ reason: "stale" });
    });

    it("a history write that fails after a delete still finishes the run and prints the result", async () => {
        const one = folder(join(allowed, "log-one"));
        const two = folder(join(allowed, "log-two"));
        const analyzer = new FixtureAnalyzer([allowed], home, () => [
            { id: "f:1", paths: [one] },
            { id: "f:2", paths: [two] },
        ]);
        const run = await runAct(
            opts(["f:1", "f:2"]),
            realDeps(analyzer, {
                remove: realRemove,
                appendHistory: async () => {
                    throw new Error("ENOSPC: no space left on device");
                },
            })
        );

        expect(run.result.items.map((item) => item.status)).toEqual(["ok", "ok"]);
        expect(run.result.items[0]?.error).toContain("ENOSPC");
        expect(existsSync(one) || existsSync(two)).toBe(false);
    });
});
