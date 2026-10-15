import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import {
    chmodSync,
    closeSync,
    ftruncateSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    realpathSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppBloatAnalyzer } from "@app/doctor/analyzers/app-bloat";
import { dockerFindingId } from "@app/doctor/analyzers/dev-caches";
import { DiskSpaceAnalyzer } from "@app/doctor/analyzers/disk-space";
import { TempLeaksAnalyzer, tmpPrefix } from "@app/doctor/analyzers/temp-leaks";
import { runAct } from "@app/doctor/lib/act";
import { measurePath, measurePaths } from "@app/doctor/lib/fs-measure";
import { vmDataReason } from "@app/doctor/lib/path-guard";
import type { ProcInfo } from "@app/doctor/lib/processes";
import { evaluateScanGate, parseFseventsdRss, recordScanGate, type ScanGateState } from "@app/doctor/lib/scan-gate";
import type { AnalyzerContext, Finding } from "@app/doctor/lib/types";
import { buildJsonDocument, toJsonFinding } from "@app/doctor/ui/json";
import {
    byKeys,
    type ContractShapeOptions,
    contractShapeMismatches,
    readKitFixtureJson,
} from "@app/macos/lib/kit-fixtures";
import { env } from "@genesiscz/utils/env";
import * as diskUsage from "@genesiscz/utils/fs/disk-usage";
import { SafeJSON } from "@genesiscz/utils/json";

describe("measurement safety", () => {
    it("marks traversal errors and unreadable aggregate paths incomplete", () => {
        const dir = mkdtempSync(join(tmpdir(), "doctor-measure-errors-"));
        const walk = spyOn(diskUsage, "walkFiles").mockImplementation(function* (path, options) {
            options?.onError?.({ path: join(path, "unreadable"), errno: "EACCES" });
            yield { path: join(path, "seen"), logical: 100, allocated: 100, privateSize: 10, mtimeNs: 0n };
        });
        try {
            expect(measurePath(dir)).toMatchObject({ complete: false, errors: 1 });
            expect(measurePaths([dir, join(dir, "missing")])).toMatchObject({
                complete: false,
                freeableFloorBytes: null,
            });
        } finally {
            walk.mockRestore();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it.each([1, 2])("keeps shared bytes out of the floor with %i clone members inside the tree", (members) => {
        const dir = mkdtempSync(join(tmpdir(), "doctor-clone-floor-"));
        const walk = spyOn(diskUsage, "walkFiles").mockImplementation(function* (path) {
            for (let i = 0; i < members; i++) {
                yield {
                    path: join(path, String(i)),
                    logical: 100,
                    allocated: 100,
                    privateSize: 0,
                    cloneIdHex: "abcd",
                    mtimeNs: 0n,
                };
            }
            yield {
                path: join(path, "private"),
                logical: 25,
                allocated: 25,
                privateSize: 25,
                cloneIdHex: "",
                mtimeNs: 0n,
            };
        });
        try {
            expect(measurePath(dir)).toMatchObject({
                freeableFloorBytes: 25,
                allocatedBytes: members * 100 + 25,
                complete: true,
            });
        } finally {
            walk.mockRestore();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

const DAY = 86_400_000;
const OPEN_GATE: ScanGateState = evaluateScanGate({
    availableBytes: 50 * 1024 ** 3,
    fseventsdRssBytes: 20 * 1024 ** 2,
});
const HOT_GATE: ScanGateState = evaluateScanGate({ availableBytes: 500 * 1024 ** 2, fseventsdRssBytes: 2 * 1024 ** 3 });
const ctx: AnalyzerContext = {
    runId: "reclaim-analyzers-test",
    opts: { thorough: false, fresh: true, dryRun: true },
    emit: () => {},
};

let root: string;

const FINDINGS_CONTRACT = readKitFixtureJson("contract-doctor-findings.json");
/**
 * Findings come in kinds with their own metadata, so each is checked against the contract finding of its kind.
 * `freeableFloorBytes` is written only when the volume can say how much a delete frees (clone-aware).
 */
const FINDINGS_SHAPE: ContractShapeOptions = {
    kinds: { "$.findings[]": byKeys("metadata.kind") },
    optionalKeys: { "$.findings[].metadata": ["freeableFloorBytes"] },
};

/** The produced `--json` finding has the keys and nesting of the contract finding of the same kind. */
function expectMatchesContract(finding: Finding | undefined): void {
    expect(finding).toBeDefined();
    const document = { ...(FINDINGS_CONTRACT as object), findings: [toJsonFinding(finding as Finding, false)] };
    expect(contractShapeMismatches(document, FINDINGS_CONTRACT, FINDINGS_SHAPE)).toEqual([]);
}

beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-reclaim-")));
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

function touch(path: string, msAgo: number, now: number): void {
    const at = new Date(now - msAgo);
    utimesSync(path, at, at);
}

function file(path: string, bytes: number): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes, 7));
    return path;
}

/** A file whose apparent size is `apparent` but which holds almost no blocks. */
function sparse(path: string, apparent: number): string {
    mkdirSync(join(path, ".."), { recursive: true });
    const fd = openSync(path, "w");
    ftruncateSync(fd, apparent);
    closeSync(fd);
    return path;
}

async function collect(
    analyzer: { recheck: (ids: string[], c: AnalyzerContext) => Promise<Finding[]> },
    ids: string[]
) {
    return analyzer.recheck(ids, ctx);
}

async function all(analyzer: TempLeaksAnalyzer | AppBloatAnalyzer): Promise<Finding[]> {
    const result = await analyzer.analyze(ctx);
    return result.findings;
}

describe("tmpPrefix", () => {
    it("keeps the stable name and drops generated suffixes", () => {
        expect(tmpPrefix("md-chrome-A1b2C3")).toBe("md-chrome");
        expect(tmpPrefix("kibana-bodies-1760000000.json")).toBe("kibana-bodies");
        expect(tmpPrefix("TemporaryDirectory.AbCdEf")).toBe("TemporaryDirectory");
        expect(tmpPrefix("4f3c2b1a9e8d")).toBe("(unnamed)");
    });
});

describe("scan gate", () => {
    it("gates on a full volume or a hot fseventsd", () => {
        expect(OPEN_GATE.gated).toBe(false);
        expect(HOT_GATE.gated).toBe(true);
        expect(HOT_GATE.reasons).toHaveLength(2);
    });

    it("reads fseventsd resident memory from ps", () => {
        const ps =
            "  1234 /usr/sbin/cfprefsd\n 30000 /System/Library/Frameworks/CoreServices.framework/Versions/A/Support/fseventsd\n";
        expect(parseFseventsdRss(ps)).toBe(30000 * 1024);
    });
});

describe("temp-leaks", () => {
    it("T1 lists a code_sign_clone no running browser owns, keeps the owned and the young ones, and names the off switch", async () => {
        const xDir = join(root, "t1", "X");
        const browser = join(xDir, "com.example.Browser.code_sign_clone");
        const leaked = join(browser, "code_sign_clone.Ok4jVh");
        const owned = join(browser, "code_sign_clone.aKu3zG");
        const young = join(xDir, "com.example.Other.code_sign_clone", "code_sign_clone.Yy1Zz2");
        file(join(leaked, "Example Browser.app.bundle", "Contents", "MacOS", "Example Browser"), 4096);
        file(join(owned, "Example Browser.app.bundle", "Contents", "MacOS", "Example Browser"), 4096);
        file(join(young, "Other.app.bundle", "Contents", "MacOS", "Other"), 4096);
        const createdAt = Math.min(statSync(owned).birthtimeMs || Number.POSITIVE_INFINITY, statSync(owned).mtimeMs);
        touch(leaked, DAY, createdAt);
        const procs: ProcInfo[] = [
            {
                pid: 501,
                command: "/Applications/Example Browser.app/Contents/MacOS/Example Browser --no-startup-window",
                startedAt: new Date(createdAt - 2_000),
            },
            {
                pid: 502,
                command: "/Applications/Example Browser.app/Contents/Frameworks/Helper --type=renderer",
                startedAt: new Date(createdAt - DAY),
            },
        ];
        const analyzer = new TempLeaksAnalyzer({
            xDir,
            tmpDir: null,
            ccRoot: join(root, "t1", "none"),
            tmpRoot: join(root, "t1", "none"),
            repoRoots: [],
            now: () => createdAt + 5 * 60_000,
            processes: async () => procs,
            cwds: () => new Map(),
            gate: async () => OPEN_GATE,
        });
        const findings = await all(analyzer);
        const clones = findings.filter((f) => f.metadata?.kind === "codesign-clone");

        expect(clones.map((f) => f.id)).toEqual(["temp-leaks:codesign-clone:com.example.Browser:Ok4jVh"]);
        expect(clones[0]?.detail).toContain("--disable-features=MacAppCodeSignClone");
        expect(clones[0]?.detail).toContain("Browser.close");
        expect(clones[0]?.detail).not.toContain("chrome-devtools close");
        expect(clones[0]?.metadata?.prevention).toEqual({
            chromeFlag: "--disable-features=MacAppCodeSignClone",
            close: expect.stringContaining("never a kill signal"),
        });
        expect(clones[0]?.metadata?.paths).toEqual([leaked]);
        expect(clones[0]?.actions[0]?.kind).toBe("remove-path");
        expectMatchesContract(clones[0]);
    });

    it("T2 lists a stale /tmp/cc session, leaves out worktrees and git checkouts, and skips a live one", async () => {
        const now = Date.now();
        const cc = join(root, "t2", "cc");
        const stale = join(cc, "Shop", "5d2c9e1a-7b44-4c1e-9a0f-2f6b1d3e8c71");
        const live = join(cc, "Shop", "9f8e7d6c-5b4a-4321-8fed-cba987654321");
        file(join(stale, "bench", "data.bin"), 64 * 1024);
        file(join(stale, "notes.txt"), 100);
        file(join(stale, "worktrees", "kit", ".git"), 40);
        file(join(stale, "clone", ".git", "HEAD"), 40);
        file(join(live, "work", "data.bin"), 64 * 1024);

        for (const path of [
            join(stale, "bench", "data.bin"),
            join(stale, "bench"),
            join(stale, "notes.txt"),
            join(stale, "clone", ".git", "HEAD"),
            join(stale, "clone", ".git"),
            join(stale, "clone"),
            join(stale, "worktrees", "kit", ".git"),
            join(stale, "worktrees", "kit"),
            join(stale, "worktrees"),
            stale,
        ]) {
            touch(path, 6 * DAY, now);
        }

        const analyzer = new TempLeaksAnalyzer({
            xDir: null,
            tmpDir: null,
            ccRoot: cc,
            tmpRoot: join(root, "t2", "none"),
            repoRoots: [],
            now: () => now,
            processes: async () => [],
            cwds: () => new Map(),
            gate: async () => OPEN_GATE,
            thresholds: { scratchMinBytes: 1 },
        });
        const findings = await all(analyzer);
        const sessions = findings.filter((f) => f.metadata?.kind === "tmp-cc-session");
        const worktrees = findings.filter((f) => f.metadata?.kind === "tmp-cc-worktree");

        expect(sessions.map((f) => f.id)).toEqual([
            "temp-leaks:tmp-cc-session:Shop:5d2c9e1a-7b44-4c1e-9a0f-2f6b1d3e8c71",
        ]);
        const session = sessions[0] as Finding;
        expect([...((session.metadata?.paths ?? []) as string[])].sort()).toEqual(
            [join(stale, "bench"), join(stale, "notes.txt")].sort()
        );
        const excluded = ((session.metadata?.excluded ?? []) as Array<{ path: string }>).map((e) => e.path).sort();
        expect(excluded).toEqual([join(stale, "clone"), join(stale, "worktrees")].sort());
        expect(worktrees.map((f) => f.metadata?.paths)).toEqual([[join(stale, "worktrees", "kit")]]);
        expect(worktrees[0]?.actions).toEqual([]);
        expectMatchesContract(sessions[0]);
    });

    it("an errored scratch walk never reaches the irreversible remover", async () => {
        const now = Date.now();
        const cc = join(root, "errored-scratch", "cc");
        const session = join(cc, "Shop", "session-fixture");
        const tree = join(session, "data");
        file(join(tree, "old.bin"), 100);
        for (const path of [join(tree, "old.bin"), tree, session]) {
            touch(path, 6 * DAY, now);
        }
        const walk = spyOn(diskUsage, "walkFiles").mockImplementation(function* (path, options) {
            options?.onError?.({ path: join(path, "nested-checkout"), errno: "EACCES" });
            yield {
                path: join(path, "old.bin"),
                logical: 100,
                allocated: 100,
                privateSize: 100,
                mtimeNs: BigInt(now - 6 * DAY) * 1_000_000n,
            };
        });
        let removals = 0;
        try {
            const analyzer = new TempLeaksAnalyzer({
                xDir: null,
                tmpDir: null,
                ccRoot: cc,
                tmpRoot: join(root, "absent"),
                repoRoots: [],
                now: () => now,
                processes: async () => [],
                cwds: () => new Map(),
                gate: async () => OPEN_GATE,
                thresholds: { scratchMinBytes: 1 },
            });
            const findings = await all(analyzer);
            const finding = findings.find((f) => f.metadata?.kind === "tmp-cc-session");
            expect(finding).toBeDefined();
            const result = await runAct(
                {
                    actionId: finding!.actions[0]!.id,
                    analyzerId: analyzer.id,
                    ids: [finding!.id],
                    method: "delete",
                    yes: true,
                    confirm: ["DELETE"],
                    dryRun: false,
                    argv: [],
                },
                {
                    analyzers: [analyzer],
                    manifestsDir: join(root, "errored-manifests"),
                    lockPath: join(root, "errored.lock"),
                    home: root,
                    processes: async () => [],
                    cwds: () => new Map(),
                    statfs: () => null,
                    appendHistory: async () => {},
                    remove: async () => {
                        removals++;
                        throw new Error("unsafe remover reached");
                    },
                }
            );
            expect(result.exitCode).toBe(1);
            expect(removals).toBe(0);
        } finally {
            walk.mockRestore();
        }
    });

    it("T2 and T7 are skipped while the scan gate is hot", async () => {
        const analyzer = new TempLeaksAnalyzer({
            xDir: null,
            tmpDir: null,
            ccRoot: join(root, "t2", "cc"),
            tmpRoot: join(root, "t2", "none"),
            repoRoots: [],
            processes: async () => [],
            cwds: () => new Map(),
            gate: async () => HOT_GATE,
            thresholds: { scratchMinBytes: 1 },
        });
        const findings = await all(analyzer);
        expect(findings.filter((f) => f.metadata?.kind === "tmp-cc-session")).toEqual([]);
    });

    it("T5 groups old $TMPDIR entries by prefix, owned prefixes after one day, others after three", async () => {
        const now = Date.now();
        const tmp = join(root, "t5", "T");
        const owned = join(tmp, "md-chrome-A1b2C3");
        file(join(owned, "page.html"), 2048);
        touch(join(owned, "page.html"), 2 * DAY, now);
        touch(owned, 2 * DAY, now);
        const foreignOld = file(join(tmp, "kibana-bodies-1760000001.json"), 300);
        touch(foreignOld, 4 * DAY, now);
        const foreignYoung = file(join(tmp, "kibana-bodies-1760000002.json"), 300);
        touch(foreignYoung, 2 * DAY, now);
        const lock = file(join(tmp, "_private_tmp_cc_x_.build_Package.resolved.lock"), 0);
        touch(lock, 9 * DAY, now);
        const analyzer = new TempLeaksAnalyzer({
            xDir: null,
            tmpDir: tmp,
            ccRoot: join(root, "t5", "none"),
            tmpRoot: join(root, "t5", "none"),
            repoRoots: [],
            now: () => now,
            processes: async () => [],
            cwds: () => new Map(),
            gate: async () => OPEN_GATE,
            thresholds: { tmpdirGroupMinBytes: 1, tmpdirGroupMinEntries: 1 },
        });
        const groups = (await all(analyzer)).filter((f) => f.metadata?.kind === "tmpdir-group");
        const byId = new Map(groups.map((f) => [f.id, f]));

        expect([...byId.keys()].sort()).toEqual(["temp-leaks:tmpdir:kibana-bodies", "temp-leaks:tmpdir:md-chrome"]);
        expect(byId.get("temp-leaks:tmpdir:md-chrome")?.severity).toBe("safe");
        expect(byId.get("temp-leaks:tmpdir:kibana-bodies")?.severity).toBe("cautious");
        expect(byId.get("temp-leaks:tmpdir:kibana-bodies")?.metadata?.paths).toEqual([foreignOld]);
        expectMatchesContract(byId.get("temp-leaks:tmpdir:md-chrome"));
    });

    it("T7 lists a stale SwiftPM .build copy, and blocks one a swift process works in", async () => {
        const now = Date.now();
        const cc = join(root, "t7", "cc");
        const pkg = join(cc, "Shop", "1b7e4f20", "worktrees", "kit", "src", "Kit");
        file(join(pkg, "Package.swift"), 200);
        file(join(pkg, ".build", "arm64-apple-macosx", "debug", "description.json"), 4096);

        for (const path of [
            join(pkg, ".build", "arm64-apple-macosx", "debug", "description.json"),
            join(pkg, ".build", "arm64-apple-macosx", "debug"),
            join(pkg, ".build"),
        ]) {
            touch(path, 4 * DAY, now);
        }

        const make = (cwd: string | null) =>
            new TempLeaksAnalyzer({
                xDir: null,
                tmpDir: null,
                ccRoot: cc,
                tmpRoot: join(root, "t7", "none"),
                repoRoots: [],
                now: () => now,
                processes: async () => [{ pid: 777, command: "/usr/bin/swift-build --product Kit", startedAt: null }],
                cwds: () => (cwd ? new Map([[777, cwd]]) : new Map()),
                gate: async () => OPEN_GATE,
            });
        const idle = await collect(make(null), [`temp-leaks:swiftpm-build:${join(pkg, ".build")}`]);
        const busy = await collect(make(pkg), [`temp-leaks:swiftpm-build:${join(pkg, ".build")}`]);

        expect(idle).toHaveLength(1);
        expect(idle[0]?.severity).toBe("safe");
        expect(idle[0]?.metadata?.blockers).toBeUndefined();
        expect(busy[0]?.metadata?.blockers).toEqual([expect.stringContaining("pid 777")]);
        expectMatchesContract(idle[0]);
    });
});

describe("temp-leaks SwiftPM search in a git checkout", () => {
    it("reads Package.swift locations from the index instead of walking the checkout", async () => {
        const now = Date.now();
        const cc = join(root, "t7git", "cc");
        const repo = join(cc, "Shop", "2c3d4e5f", "checkout");
        const pkg = join(repo, "deep", "a", "b", "c", "d", "e", "Kit");
        file(join(pkg, "Package.swift"), 200);
        file(join(pkg, ".build", "debug.yaml"), 100);
        touch(join(pkg, ".build", "debug.yaml"), 5 * DAY, now);
        touch(join(pkg, ".build"), 5 * DAY, now);
        Bun.spawnSync(["git", "init", "-q", repo], { env: env.getProcessEnv() });
        Bun.spawnSync(["git", "-C", repo, "add", "deep/a/b/c/d/e/Kit/Package.swift"], { env: env.getProcessEnv() });
        const analyzer = new TempLeaksAnalyzer({
            xDir: null,
            tmpDir: null,
            ccRoot: cc,
            tmpRoot: join(root, "t7git", "none"),
            repoRoots: [],
            now: () => now,
            processes: async () => [],
            cwds: () => new Map(),
            gate: async () => OPEN_GATE,
        });
        const found = await collect(analyzer, [`temp-leaks:swiftpm-build:${join(pkg, ".build")}`]);

        expect(found.map((f) => f.metadata?.paths)).toEqual([[join(pkg, ".build")]]);
    });
});

describe("app-bloat", () => {
    let home: string;
    const now = Date.now();

    beforeAll(() => {
        home = join(root, "home");
        const shipIt = join(home, "Library", "Caches", "com.example.notes.ShipIt");
        file(join(shipIt, "update.Qx7Lm2", "Notes.app", "Contents", "Info.plist"), 4096);
        file(join(shipIt, "update.Zr4Kp9", "Notes.app", "Contents", "Info.plist"), 4096);
        file(join(shipIt, "ShipItState.plist"), 64);
        file(join(home, "Library", "Caches", "ms-playwright", "chromium-1", "chrome"), 8192);
        const bundle = join(home, "Library", "Application Support", "Claude", "vm_bundles", "claudevm.bundle");
        sparse(join(bundle, "rootfs.img"), 512 * 1024 * 1024);
        file(join(bundle, "sessiondata.img"), 8192);
        file(join(bundle, "rootfs.img.zst"), 4096);
        touch(join(bundle, "rootfs.img"), 3 * DAY, now);
        touch(join(bundle, "sessiondata.img"), 3 * DAY, now);
        sparse(
            join(home, "Library", "Group Containers", "HUAQ24HBR6.dev.orbstack", "data", "data.img.raw"),
            2 * 1024 ** 3
        );
    });

    function analyzer(procs: ProcInfo[] = []): AppBloatAnalyzer {
        return new AppBloatAnalyzer({
            home,
            toolsHome: home,
            now: () => now,
            processes: async () => procs,
            gate: async () => OPEN_GATE,
            openWriters: async () => [],
            readPlist: async () => ({
                updateBundleURL: `file://${join(home, "Library", "Caches", "com.example.notes.ShipIt", "update.Zr4Kp9")}/`,
            }),
            cacheMinBytes: 1,
        });
    }

    it("B7 lists only the update download ShipItState.plist does not stage", async () => {
        const findings = (await all(analyzer())).filter((f) => f.metadata?.kind === "shipit-update");
        expect(findings.map((f) => f.id)).toEqual(["app-bloat:shipit-update:com.example.notes.ShipIt:update.Qx7Lm2"]);
        expect(findings[0]?.severity).toBe("safe");
    });

    it.skipIf(process.platform !== "darwin")("B7 reads a real ShipItState.plist with plutil", async () => {
        const shipIt = join(home, "Library", "Caches", "com.example.notes.ShipIt");
        const staged = join(shipIt, "update.Zr4Kp9");
        writeFileSync(
            join(shipIt, "ShipItState.plist"),
            `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>updateBundleURL</key><string>file://${staged}/Notes.app/</string></dict></plist>
`
        );
        const real = new AppBloatAnalyzer({
            home,
            toolsHome: home,
            now: () => now,
            processes: async () => [],
            gate: async () => OPEN_GATE,
            openWriters: async () => [],
            cacheMinBytes: 1,
        });
        const ids = (await all(real)).filter((f) => f.metadata?.kind === "shipit-update").map((f) => f.id);
        expect(ids).toEqual(["app-bloat:shipit-update:com.example.notes.ShipIt:update.Qx7Lm2"]);
    });

    it("B1 sizes the VM disks by allocated blocks, keeps the seed, and blocks while Claude runs", async () => {
        const quiet = (await collect(analyzer(), ["app-bloat:claude-vm-bundles"]))[0];
        const busy = (
            await collect(
                analyzer([{ pid: 9, command: "/Applications/Claude.app/Contents/MacOS/Claude", startedAt: null }]),
                ["app-bloat:claude-vm-bundles"]
            )
        )[0];

        expect(quiet?.metadata?.paths).toHaveLength(2);
        expect(quiet?.metadata?.kept).toEqual([expect.stringMatching(/rootfs\.img\.zst$/)]);
        expect(quiet?.metadata?.apparentBytes as number).toBeGreaterThan(512 * 1024 * 1024);
        expect(quiet?.metadata?.allocatedBytes as number).toBeLessThan(64 * 1024 * 1024);
        expect(quiet?.metadata?.blockers).toBeUndefined();
        expect(quiet?.actions[0]).toMatchObject({ confirm: "typed", confirmPhrase: "DELETE" });
        expect(busy?.metadata?.blockers).toEqual([expect.stringContaining("Claude Desktop is running")]);
    });

    it("B12 reports a sparse VM disk as blocked with pinned-context guest commands and no action", async () => {
        const vm = (await collect(analyzer(), ["app-bloat:docker-sparse:orbstack"]))[0];
        expect(vm?.severity).toBe("blocked");
        expect(vm?.actions).toEqual([]);
        expect(vm?.reclaimableBytes).toBeUndefined();
        expect(vm?.metadata?.guestCommands).toContain("docker --context orbstack image prune -f");
    });

    it("B8 Playwright is blocked while a Playwright process runs", async () => {
        const path = join(home, "Library", "Caches", "ms-playwright");
        const busy = await collect(analyzer([{ pid: 4, command: "node /x/playwright/cli.js test", startedAt: null }]), [
            `app-bloat:playwright-cache:${path}`,
        ]);
        expect(busy[0]?.metadata?.blockers).toEqual([expect.stringContaining("Playwright")]);
    });

    it("every app-bloat kind in the frozen contract fixture matches what the analyzer produces", async () => {
        const produced = await all(analyzer());

        for (const kind of ["claude-vm-bundles", "shipit-update", "playwright-cache", "docker-sparse"]) {
            expectMatchesContract(produced.find((f) => f.metadata?.kind === kind));
        }
    });

    it("the --json document keeps the frozen contract's fields around its findings", async () => {
        // The analyzers read the gate through their injected reader; the document reports the process's last reading.
        recordScanGate(OPEN_GATE);
        const document = await buildJsonDocument({
            analyzers: [analyzer()],
            runId: "contract",
            thorough: false,
            fresh: true,
            dryRun: true,
        });

        expect(document.findings.map((f) => f.metadata?.kind).sort()).toEqual(
            ["claude-vm-bundles", "docker-sparse", "playwright-cache", "shipit-update"].sort()
        );
        expect(contractShapeMismatches(document, FINDINGS_CONTRACT, FINDINGS_SHAPE)).toEqual([]);
    });
});

describe("review fixes: app-bloat", () => {
    const now = Date.now();
    let home2: string;

    beforeAll(() => {
        home2 = join(root, "home2");
    });

    function bloat(procs: ProcInfo[] | (() => Promise<ProcInfo[]>) = []): AppBloatAnalyzer {
        return new AppBloatAnalyzer({
            home: home2,
            toolsHome: home2,
            now: () => now,
            processes: typeof procs === "function" ? procs : async () => procs,
            gate: async () => OPEN_GATE,
            openWriters: async () => [],
            readPlist: async () => null,
            cacheMinBytes: 1,
        });
    }

    function workspace(hash: string, folder: string): string {
        const dir = join(home2, "Library", "Application Support", "Cursor", "User", "workspaceStorage", hash);
        file(join(dir, "workspace.json"), 0);
        writeFileSync(join(dir, "workspace.json"), SafeJSON.stringify({ folder: `file://${folder}` }));
        file(join(dir, "state.vscdb"), 4096);
        return dir;
    }

    it("H4 a Cursor workspace is dead only when its folder is positively gone, never on an unmounted volume or EACCES", async () => {
        const projects = join(home2, "projects");
        mkdirSync(projects, { recursive: true });
        const gone = workspace("aaa111", join(projects, "deleted-project"));
        workspace("bbb222", `/Volumes/NotMounted-${Date.now()}/proj`);
        const lockedParent = join(home2, "locked");
        mkdirSync(join(lockedParent, "proj"), { recursive: true });
        workspace("ccc333", join(lockedParent, "proj"));
        chmodSync(lockedParent, 0o000);

        try {
            const dead = (await all(bloat())).find((f) => f.metadata?.kind === "cursor-workspace-storage-dead");
            expect(dead?.metadata?.paths).toEqual([gone]);
            expect(dead?.metadata?.targets).toEqual([{ path: gone, folder: join(projects, "deleted-project") }]);
            expect(dead?.detail).toContain("deleted-project");
            expect(dead?.actions[0]?.confirm).toBe("typed");
        } finally {
            chmodSync(lockedParent, 0o755);
        }
    });

    it("M3 the Playwright and cursor-agent checks ignore the act process itself and an idle MCP server", async () => {
        const cache = join(home2, "Library", "Caches", "ms-playwright");
        file(join(cache, "chromium-1", "chrome"), 8192);
        const versions = join(home2, ".local", "share", "cursor-agent", "versions");
        file(join(versions, "2026.01.01-aaa", "cursor-agent"), 4096);
        file(join(versions, "2026.10.01-bbb", "cursor-agent"), 4096);
        touch(join(versions, "2026.01.01-aaa"), 30 * DAY, now);
        const self: ProcInfo[] = [
            {
                pid: process.pid,
                ppid: process.ppid,
                command: `bun src/doctor/index.ts act delete-app-cache --analyzer app-bloat --id app-bloat:playwright-cache:${cache} --id app-bloat:cursor-agent-versions:cli`,
                startedAt: null,
            },
            {
                pid: process.ppid,
                ppid: 1,
                command: `zsh -c tools doctor act --id app-bloat:playwright-cache:${cache} cursor-agent`,
                startedAt: null,
            },
            { pid: 7001, ppid: 1, command: "node /Users/alice/.bun/bin/playwright-mcp", startedAt: null },
        ];
        const findings = await collect(bloat(self), [
            `app-bloat:playwright-cache:${cache}`,
            "app-bloat:cursor-agent-versions:cli",
        ]);

        expect(findings).toHaveLength(2);
        expect(findings.map((f) => f.metadata?.blockers)).toEqual([undefined, undefined]);

        const browser = await collect(
            bloat([{ pid: 7002, ppid: 1, command: `${cache}/chromium-1/chrome --headless`, startedAt: null }]),
            [`app-bloat:playwright-cache:${cache}`]
        );
        const agent = await collect(
            bloat([
                { pid: 7003, ppid: 1, command: `${versions}/2026.10.01-bbb/cursor-agent --serve`, startedAt: null },
            ]),
            ["app-bloat:cursor-agent-versions:cli"]
        );
        expect(browser[0]?.metadata?.blockers).toEqual([expect.stringContaining("Playwright")]);
        expect(agent[0]?.metadata?.blockers).toEqual([expect.stringContaining("cursor-agent")]);
    });

    it("M4 the Android emulator user data passes the act path guard", async () => {
        const avd = join(home2, ".android", "avd");
        file(join(avd, "old.avd", "userdata-qemu.img.qcow2"), 8192);
        file(join(avd, "new.avd", "userdata-qemu.img.qcow2"), 8192);
        touch(join(avd, "old.avd", "userdata-qemu.img.qcow2"), 20 * DAY, now);
        const run = await runAct(
            {
                actionId: "delete-app-cache",
                analyzerId: "app-bloat",
                ids: ["app-bloat:android-avd:old.avd"],
                method: "delete",
                yes: true,
                confirm: [],
                dryRun: true,
                argv: [],
            },
            {
                analyzers: [bloat()],
                home: home2,
                processes: async () => [{ pid: 1, command: "/sbin/launchd", startedAt: null }],
                cwds: () => new Map(),
            }
        );

        expect(run.result.items[0]).toMatchObject({ status: "skipped" });
    });

    it("M2 a failed process list blocks every rule that needs it instead of dropping the blockers", async () => {
        const bundle = join(home2, "Library", "Application Support", "Claude", "vm_bundles", "claudevm.bundle");
        file(join(bundle, "rootfs.img"), 8192);
        touch(join(bundle, "rootfs.img"), 3 * DAY, now);
        const vm = await collect(
            bloat(async () => {
                throw new Error("ps timed out");
            }),
            ["app-bloat:claude-vm-bundles"]
        );

        expect(vm[0]?.metadata?.blockers).toEqual([expect.stringContaining("process list")]);
    });
});

describe("review fixes: temp-leaks and disk-space", () => {
    it("L3 a moved-aside folder younger than a day is not offered", async () => {
        const cc = join(root, "l3", "cc");
        const moved = join(cc, "Shop", "s1", "removals", "old-bins");
        file(join(moved, "x.bin"), 4096);
        const make = (offsetMs: number) =>
            new TempLeaksAnalyzer({
                xDir: null,
                tmpDir: null,
                ccRoot: cc,
                tmpRoot: join(root, "l3", "none"),
                repoRoots: [],
                now: () => Date.now() + offsetMs,
                processes: async () => [],
                cwds: () => new Map(),
                gate: async () => OPEN_GATE,
            });
        const id = `temp-leaks:moved-aside:${moved}`;

        expect(await collect(make(0), [id])).toEqual([]);
        expect((await collect(make(2 * DAY), [id])).map((f) => f.id)).toEqual([id]);
    });

    it("L4 a socket in $TMPDIR never joins a group", async () => {
        const now = Date.now();
        const tmp = join(root, "l4", "T");
        mkdirSync(tmp, { recursive: true });
        const sock = join(tmp, "vscode-ipc-1a2b3c4d.sock");
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(sock, resolve));

        try {
            touch(sock, 5 * DAY, now);
            const plain = file(join(tmp, "vscode-ipc-9f8e7d6c.log"), 300);
            touch(plain, 5 * DAY, now);
            const groups = (
                await all(
                    new TempLeaksAnalyzer({
                        xDir: null,
                        tmpDir: tmp,
                        ccRoot: join(root, "l4", "none"),
                        tmpRoot: join(root, "l4", "none"),
                        repoRoots: [],
                        now: () => now,
                        processes: async () => [],
                        cwds: () => new Map(),
                        gate: async () => OPEN_GATE,
                        thresholds: { tmpdirGroupMinBytes: 1, tmpdirGroupMinEntries: 1 },
                    })
                )
            ).filter((f) => f.metadata?.kind === "tmpdir-group");

            expect(groups.flatMap((f) => f.metadata?.paths as string[])).toEqual([plain]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("M2 temp-leaks lists no code_sign_clone leak when the process list cannot be read", async () => {
        const xDir = join(root, "m2", "X");
        const clone = join(xDir, "com.example.Browser.code_sign_clone", "code_sign_clone.Zz9Yy8");
        file(join(clone, "Example Browser.app.bundle", "x"), 4096);
        touch(clone, 2 * DAY, Date.now());
        const findings = await all(
            new TempLeaksAnalyzer({
                xDir,
                tmpDir: null,
                ccRoot: join(root, "m2", "none"),
                tmpRoot: join(root, "m2", "none"),
                repoRoots: [],
                processes: async () => {
                    throw new Error("ps failed");
                },
                cwds: () => new Map(),
                gate: async () => OPEN_GATE,
            })
        );

        expect(findings.filter((f) => f.metadata?.kind === "codesign-clone")).toEqual([]);
    });

    it("M6 more VM and container disks are denied by path and by name", () => {
        const home = "/Users/alice";
        for (const path of [
            `${home}/.local/share/containers/podman/machine/qemu/podman-machine-default.raw`,
            `${home}/Library/Application Support/rancher-desktop/lima/0/diffdisk`,
            `${home}/.tart/vms/sonoma/disk.img`,
            `${home}/.docker/machine/machines/default/disk.vmdk`,
            `${home}/Downloads/basedisk`,
        ]) {
            expect(vmDataReason(path, home)).not.toBeNull();
        }

        expect(vmDataReason(`${home}/.android/avd/old.avd/userdata-qemu.img.qcow2`, home)).toBeNull();
        expect(vmDataReason(`${home}/Movies/export.mov`, home)).toBeNull();
    });

    it("L7 a large file in a synced folder is never a plain removal: Tresorit is blocked, cloud storage is typed", async () => {
        const home = join(root, "l7");
        const tresor = join(home, "Tresors", "Work");
        mkdirSync(join(tresor, ".tresorit"), { recursive: true });
        file(join(tresor, "archive.zip"), 3 * 1024 * 1024);
        const drive = file(join(home, "Library", "CloudStorage", "Drive-alice", "video.mp4"), 3 * 1024 * 1024);
        const findings = await new DiskSpaceAnalyzer({ home, largeFileMinBytes: 2 * 1024 * 1024 }).findAdhoc({
            root: home,
            minMB: 1,
            maxDays: 30,
        });
        const byPath = new Map(findings.map((f) => [f.metadata?.path, f]));

        expect(byPath.get(join(tresor, "archive.zip"))?.severity).toBe("blocked");
        expect(byPath.get(drive)?.metadata?.cloudSync).toBe("cloudstorage");
        expect(byPath.get(drive)?.actions.every((a) => a.id === "reveal" || a.confirm === "typed")).toBe(true);
    });

    it("L5 the Docker finding id names the pinned context", () => {
        expect(dockerFindingId("orbstack")).toBe("dev-docker-unused-images:orbstack");
    });
});

const MB = 1024 * 1024;

describe("an unknown lsof answer blocks removal", () => {
    it("U1 a finished day log whose writers lsof could not read is not deletable", async () => {
        const home = join(root, "u1");
        const now = Date.now();
        const log = file(join(home, ".genesis-tools", "logs", "2020-01-01.log"), 3 * MB);
        touch(log, 2 * DAY, now);
        const analyzer = new AppBloatAnalyzer({
            home,
            toolsHome: home,
            now: () => now,
            processes: async () => [],
            gate: async () => OPEN_GATE,
            openWriters: async () => null,
            bigLogMinBytes: MB,
        });
        const finding = (await all(analyzer)).find((f) => f.metadata?.kind === "big-log");
        expect(finding?.metadata?.blockers).toContain(
            "lsof could not tell whether a process still writes it: not deleted"
        );
    });

    it("U2 a large file whose open state lsof could not read is blocked, not offered as closed", async () => {
        const home = join(root, "u2");
        const movie = file(join(home, "export.mov"), 3 * MB);
        const analyzer = new DiskSpaceAnalyzer({
            home,
            gate: async () => OPEN_GATE,
            largeFileMinBytes: 2 * MB,
            openFiles: async () => null,
        });
        const finding = (await analyzer.analyze(ctx)).findings.find((f) => f.metadata?.path === movie);
        expect(finding?.metadata?.blockers).toEqual([
            "lsof could not tell whether a process holds it open: not offered until a scan can check",
        ]);
    });
});
