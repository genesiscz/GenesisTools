import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { writePidFile } from "@genesiscz/utils/process/pidfile";
import { processFixture } from "./__tests__/process-fixture";
import type { CdpCallOptions, CdpEventListener } from "./cdp.ts";
import { actionsFromFindings, clearStalePidfile, killRecorderPid, partitionForYes } from "./cleanup.ts";
import { findingsFromStatus } from "./doctor.ts";
import { ensureCaptureDir, recorderPidPath } from "./paths.ts";
import { type ResumeConn, runResume, selectResumeTargets } from "./resume.ts";
import { ancestorPids, type StatusReport } from "./status.ts";

const emptySegments = { count: 0, bytes: 0, oldestMs: null, newestMs: null };

describe("findingsFromStatus (doctor is pure — it can never mutate)", () => {
    test("stale pidfile, orphan, legacy files and empty debug flag each produce a finding with a fix", () => {
        const report: StatusReport = {
            ports: [
                {
                    port: 9222,
                    pidState: {
                        status: "dead",
                        pid: 4242,
                        record: { pid: 4242, command: "bun record", startedAt: 1, writtenAt: 1 },
                    },
                    meta: null,
                    sample: null,
                    segments: { count: 3, bytes: 1000, oldestMs: 1, newestMs: 2 },
                    endpoint: null,
                },
            ],
            legacyFiles: ["/tmp/cdp-arm-9222.jsonl"],
            orphans: [
                {
                    pid: 777,
                    command: "bun .../skills/chrome-devtools/scripts/chrome-devtools.ts arm --port 9222",
                    sample: null,
                },
            ],
        };

        const findings = findingsFromStatus(report, ["brave"]);
        const ids = findings.map((f) => f.id);
        expect(ids).toContain("stale-pidfile-9222");
        expect(ids).toContain("leftover-buffer-9222");
        expect(ids).toContain("orphan-777");
        expect(ids).toContain("legacy-arm-files");
        expect(ids).toContain("empty-debug-flag-brave");
        for (const f of findings) {
            if (f.severity !== "warn" || !f.id.startsWith("over-cap")) {
                expect(f.title.length).toBeGreaterThan(0);
            }
        }

        const orphan = findings.find((f) => f.id === "orphan-777");
        expect(orphan?.title).toContain("OLD-skill");
        expect(orphan?.fix).toContain("cleanup --kill 777");
    });

    test("a recycled pid is an err finding that clears the pidfile, never kills", () => {
        const report: StatusReport = {
            ports: [
                {
                    port: 9223,
                    pidState: {
                        status: "foreign",
                        pid: 891,
                        record: { pid: 891, command: "bun record", startedAt: 1, writtenAt: 1 },
                        command: "WiFiCloudAssetsXPCService",
                    },
                    meta: null,
                    sample: null,
                    segments: emptySegments,
                    endpoint: null,
                },
            ],
            legacyFiles: [],
            orphans: [],
        };

        const findings = findingsFromStatus(report, []);
        const recycled = findings.find((f) => f.id === "recycled-pid-9223");
        expect(recycled?.severity).toBe("err");
        expect(recycled?.detail).toContain("Never kill it");
        expect(recycled?.fix).toContain("cleanup --stale 9223");
    });

    test("a clean report yields zero findings", () => {
        expect(findingsFromStatus({ ports: [], legacyFiles: [], orphans: [] }, [])).toEqual([]);
    });

    test("a possibly held popup suggests resume, and a port without one adds nothing", () => {
        const findings = findingsFromStatus(
            { ports: [], legacyFiles: [], orphans: [] },
            [],
            [
                { port: 9278, urls: [""] },
                { port: 9279, urls: [] },
            ]
        );

        expect(findings.map((f) => f.id)).toEqual(["held-popup-9278"]);
        expect(findings[0].fix).toContain("resume --port 9278");
    });
});

interface FakeTarget {
    targetId: string;
    type: string;
    url: string;
    openerId?: string;
    hangOn?: string;
    urlAfterRun?: string;
}

/** A fake browser connection: each target answers like Chrome, except one method of a `hangOn` target never answers. */
function fakeConn(targets: FakeTarget[]): { conn: ResumeConn; sent: string[] } {
    const sent: string[] = [];
    const bySession = new Map<string, FakeTarget>();
    const released = new Set<string>();
    const urlOf = (t: FakeTarget) => (released.has(t.targetId) && t.urlAfterRun ? t.urlAfterRun : t.url);
    const never = (options: CdpCallOptions) =>
        new Promise<unknown>((_, reject) => {
            options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });

    const send = async (
        method: string,
        params: Record<string, unknown> = {},
        sessionId?: string,
        options: CdpCallOptions = {}
    ): Promise<unknown> => {
        const target = sessionId
            ? bySession.get(sessionId)
            : (targets.find((t) => t.targetId === params.targetId) ?? bySession.get(String(params.sessionId)));
        sent.push(`${method}:${target?.targetId ?? ""}`);
        if (target?.hangOn === method) {
            return never(options);
        }

        switch (method) {
            case "Target.getTargets":
                return { targetInfos: targets.map((t) => ({ ...t, url: urlOf(t) })) };
            case "Target.getTargetInfo":
                return { targetInfo: target ? { ...target, url: urlOf(target) } : {} };
            case "Target.attachToTarget": {
                const sid = `s-${params.targetId}`;
                if (target) {
                    bySession.set(sid, target);
                }

                return { sessionId: sid };
            }
            case "Runtime.runIfWaitingForDebugger":
                if (target) {
                    released.add(target.targetId);
                }

                return {};
            default:
                return {};
        }
    };
    const noop = (_fn: CdpEventListener) => undefined;

    return { conn: { send, on: noop, off: noop }, sent };
}

describe("resume (releases held targets without hanging)", () => {
    test("a target that never answers times out alone; the others are still released, within the deadline", async () => {
        const { conn, sent } = fakeConn([
            { targetId: "opener", type: "page", url: "http://127.0.0.1:8777/opener.html" },
            {
                targetId: "popup",
                type: "page",
                url: "",
                openerId: "opener",
                urlAfterRun: "http://127.0.0.1:8777/popup.html",
            },
            {
                targetId: "frozen",
                type: "page",
                url: "https://frozen.example/",
                hangOn: "Runtime.runIfWaitingForDebugger",
            },
            { targetId: "tools", type: "page", url: "devtools://devtools/bundled/inspector.html" },
            { targetId: "sw", type: "service_worker", url: "https://frozen.example/sw.js" },
        ]);
        const perTargetMs = 300;
        const started = Date.now();
        const report = await runResume({ conn, perTargetMs });
        const elapsed = Date.now() - started;

        expect(elapsed).toBeLessThan(perTargetMs + 700);
        expect(report.timedOut).toBe(true);
        const byId = Object.fromEntries(report.records.map((r) => [r.targetId, r]));
        expect(Object.keys(byId).sort()).toEqual(["frozen", "opener", "popup"]);
        expect(byId.popup.outcome).toBe("released");
        expect(byId.popup.urlAfter).toBe("http://127.0.0.1:8777/popup.html");
        expect(byId.opener.outcome).toBe("ok");
        expect(byId.frozen).toMatchObject({ outcome: "timeout", step: "run" });
        expect(sent).toContain("Target.detachFromTarget:frozen");
        expect(sent.some((m) => m.startsWith("Runtime.evaluate") || m.startsWith("Network."))).toBe(false);
    });

    test("--match keeps the matching tab and the blank popup it opened, nothing else", () => {
        const picked = selectResumeTargets(
            [
                { targetId: "a", type: "page", url: "https://app.example/" },
                { targetId: "p", type: "page", url: "", openerId: "a" },
                { targetId: "b", type: "page", url: "https://other.example/" },
                { targetId: "q", type: "page", url: "about:blank", openerId: "b" },
                { targetId: "w", type: "worker", url: "https://app.example/w.js" },
            ],
            { match: "app.example" }
        );

        expect(picked.map((t) => t.targetId)).toEqual(["a", "p"]);
    });
});

describe("killRecorderPid (the irreversible call is guarded at the primitive)", () => {
    test("refuses to kill a pid that is not recorder-shaped, and never invokes kill", () => {
        const killed: string[][] = [];
        const exec = processFixture((argv: string[]) => {
            if (argv[0] === "kill") {
                killed.push(argv);
                throw new Error("kill must never be reached for a non-recorder pid");
            }

            // ps -axo pid=,command= shows only innocent processes
            return { exitCode: 0, stdout: "  777 1 /usr/libexec/WiFiCloudAssetsXPCService\n", stderr: "" };
        });

        const result = killRecorderPid(777, exec, () => new Map());
        expect(result.ok).toBe(false);
        expect(result.message).toContain("Refusing");
        expect(killed).toEqual([]);
    });

    test("kills a verified recorder pid via SIGTERM", () => {
        const killed: string[][] = [];
        const exec = processFixture((argv: string[]) => {
            if (argv[0] === "kill") {
                killed.push(argv);

                return { exitCode: 0, stdout: "", stderr: "" };
            }

            return {
                exitCode: 0,
                stdout: "  888 1 bun /repo/src/chrome-devtools/index.ts record --port 9222 --all-tabs\n",
                stderr: "",
            };
        });

        const result = killRecorderPid(888, exec, () => new Map());
        expect(result.ok).toBe(true);
        expect(killed).toEqual([["kill", "888"]]);
    });

    test("refuses to kill a LIVE pidfile-owned recorder and points at record --stop", () => {
        const killed: string[][] = [];
        const exec = processFixture((argv: string[]) => {
            if (argv[0] === "kill") {
                killed.push(argv);
                throw new Error("must not kill a live recorder");
            }

            return {
                exitCode: 0,
                stdout: "  500 1 bun /repo/src/chrome-devtools/index.ts record --port 9224 --all-tabs\n",
                stderr: "",
            };
        });

        const result = killRecorderPid(500, exec, () => new Map([[9224, 500]]));
        expect(result.ok).toBe(false);
        expect(result.message).toContain("record --port 9224 --stop");
        expect(killed).toEqual([]);
    });

    test("refuses to kill a launcher ANCESTOR of a live recorder (field-ops blocker regression)", () => {
        // 79111 (shell) -> 79113 (tools wrapper) -> 79118 (live recorder, pidfile-owned).
        // All three carry `record --port 9224` in their argv.
        const killed: string[][] = [];
        const psLines = [
            "  79111 1 zsh -c eval 'tools chrome-devtools record --port 9224 --all-tabs'",
            "  79113 79111 bun /repo/tools chrome-devtools record --port 9224 --all-tabs",
            "  79118 79113 bun /repo/src/chrome-devtools/index.ts record --port 9224 --all-tabs",
        ].join("\n");
        const exec = processFixture((argv: string[]) => {
            if (argv[0] === "kill") {
                killed.push(argv);
                throw new Error("must not kill a live recorder's launcher");
            }

            return { exitCode: 0, stdout: psLines, stderr: "" };
        });

        const result = killRecorderPid(79113, exec, () => new Map([[9224, 79118]]));
        expect(result.ok).toBe(false);
        expect(result.message).toContain("launcher ancestor");
        expect(killed).toEqual([]);

        const shell = killRecorderPid(79111, exec, () => new Map([[9224, 79118]]));
        expect(shell.ok).toBe(false);
        expect(killed).toEqual([]);
    });
});

describe("actionsFromFindings / partitionForYes (PR #326 review — the kills-never-batch policy, pinned)", () => {
    const FINDINGS = [
        { id: "orphan-4242" },
        { id: "stale-pidfile-9222" },
        { id: "recycled-pid-9223" },
        { id: "legacy-arm-files" },
        { id: "leftover-buffer-9224" },
        { id: "hot-recorder-9333" }, // informational — maps to no action
    ];

    test("maps findings to actions with the right kind tags", () => {
        const actions = actionsFromFindings(FINDINGS);
        expect(actions.map((a) => a.kind)).toEqual(["kill", "safe", "safe", "safe", "safe"]);
        expect(actions[0].label).toBe("kill orphan recorder pid 4242");
    });

    test("--yes may batch only the safe subset; every kill is excluded", () => {
        const { batchable, excludedKills } = partitionForYes(actionsFromFindings(FINDINGS));
        expect(batchable.every((a) => a.kind === "safe")).toBe(true);
        expect(batchable).toHaveLength(4);
        expect(excludedKills.map((a) => a.label)).toEqual(["kill orphan recorder pid 4242"]);
    });

    test("a findings list with only kills leaves nothing batchable", () => {
        const { batchable, excludedKills } = partitionForYes(
            actionsFromFindings([{ id: "orphan-1" }, { id: "orphan-2" }])
        );
        expect(batchable).toEqual([]);
        expect(excludedKills).toHaveLength(2);
    });
});

describe("ancestorPids", () => {
    test("collects the whole parent chain of owned pids, stopping at pid 1", () => {
        const exec = processFixture((argv: string[]) => {
            if (argv.includes("pid=,ppid=,command=")) {
                return { exitCode: 0, stdout: "  10 1 a\n  20 10 b\n  30 20 c\n  99 1 d\n", stderr: "" };
            }

            return { exitCode: 1, stdout: "", stderr: "" };
        });

        const ancestors = ancestorPids([30], exec);
        expect([...ancestors].sort((a, b) => a - b)).toEqual([10, 20]);
        expect(ancestors.has(99)).toBe(false);
        expect(ancestors.has(1)).toBe(false);
    });
});

describe("clearStalePidfile (ownership-safe clear)", () => {
    // Per-run port so a developer's real recorder on a fixed port can never
    // be touched; setup refuses to run over an existing pidfile regardless.
    const PORT = 50000 + (process.pid % 9999);

    const setup = () => {
        ensureCaptureDir(PORT);
        const path = recorderPidPath(PORT);
        if (existsSync(path)) {
            throw new Error(`refusing to test over an existing pidfile at ${path}`);
        }

        // A pid that is REALLY dead: a just-exited child's. process.execPath
        // (bun itself) exists on every platform; `true` does not on Windows.
        const dead = Bun.spawnSync([process.execPath, "-e", ""], { env: process.env }).pid;

        return { path, dead };
    };

    // Exclusive writes: colliding with a real recorder's claim on this port
    // (however unlikely with the per-run port) errors instead of overwriting.
    const plant = (path: string, pid?: number) => writePidFile(path, { pid, exclusive: true });

    afterEach(() => {
        rmSync(recorderPidPath(PORT), { force: true });
    });

    test("clears a stale record and refuses a live one", async () => {
        const { path, dead } = setup();
        plant(path, dead);
        expect((await clearStalePidfile(PORT)).ok).toBe(true);
        expect(existsSync(path)).toBe(false);

        plant(path);
        const refused = await clearStalePidfile(PORT);
        expect(refused.ok).toBe(false);
        expect(refused.message).toContain("LIVE");
    });

    test("a rival claim between inspect and unlink survives (rename-verify guard)", async () => {
        const { path, dead } = setup();
        plant(path, dead);

        const result = await clearStalePidfile(PORT, {
            afterInspect: () => {
                // A recorder claims the port in the race window.
                rmSync(path, { force: true });
                plant(path);
            },
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("changed while clearing");
        // The live claim was NOT destroyed (takeover restored it).
        expect(existsSync(path)).toBe(true);
    });
});
