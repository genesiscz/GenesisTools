import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import axios from "axios";
import { runMonitor } from "./monitor";

function fakeClient(snapshots: unknown[], blueNodes?: unknown[]) {
    let i = 0;
    const instance = axios.create();
    instance.interceptors.request.use((cfg) => {
        cfg.adapter = async () => {
            const url = cfg.url ?? "";

            // Blue Ocean hierarchy — do not advance the wfapi snapshot cursor.
            if (url.includes("/blue/rest/")) {
                if (blueNodes) {
                    return {
                        data: blueNodes,
                        status: 200,
                        statusText: "OK",
                        headers: {},
                        config: cfg,
                        request: {},
                    };
                }

                return {
                    data: { message: "not found" },
                    status: 404,
                    statusText: "Not Found",
                    headers: {},
                    config: cfg,
                    request: {},
                };
            }

            const data = snapshots[Math.min(i++, snapshots.length - 1)];
            return {
                data,
                status: 200,
                statusText: "OK",
                headers: {},
                config: cfg,
                request: {},
            };
        };
        return cfg;
    });
    return instance;
}

function urlAwareClient(routes: {
    snapshots: unknown[];
    buildStates?: Array<{ building: boolean; result: string | null; duration: number }>;
    blueNodes?: unknown[];
}) {
    let snapIdx = 0;
    let stateIdx = 0;
    const instance = axios.create();
    instance.interceptors.request.use((cfg) => {
        cfg.adapter = async () => {
            const url = cfg.url ?? "";
            let data: unknown;
            let status = 200;

            if (url.includes("/blue/rest/")) {
                if (routes.blueNodes) {
                    data = routes.blueNodes;
                } else {
                    data = { message: "not found" };
                    status = 404;
                }
            } else if (url.includes("/wfapi/describe")) {
                data = routes.snapshots[Math.min(snapIdx++, routes.snapshots.length - 1)];
            } else if (url.endsWith("/api/json")) {
                const states = routes.buildStates ?? [{ building: true, result: null, duration: 0 }];
                data = states[Math.min(stateIdx++, states.length - 1)];
            } else {
                throw new Error(`unexpected url: ${url}`);
            }

            return {
                data,
                status,
                statusText: status === 200 ? "OK" : "Not Found",
                headers: {},
                config: cfg,
                request: {},
            };
        };
        return cfg;
    });
    return instance;
}

describe("runMonitor", () => {
    it("emits snapshot for historical stages then stage transitions then end", async () => {
        const lines: string[] = [];
        const out = (l: string) => lines.push(l.trim());

        const snapshots = [
            {
                name: "build",
                status: "IN_PROGRESS",
                startTimeMillis: 0,
                durationMillis: 30_000,
                stages: [
                    { id: "1", name: "Clone", status: "SUCCESS", durationMillis: 20_000 },
                    { id: "2", name: "Build", status: "IN_PROGRESS", durationMillis: 10_000 },
                ],
            },
            {
                name: "build",
                status: "SUCCESS",
                startTimeMillis: 0,
                durationMillis: 50_000,
                stages: [
                    { id: "1", name: "Clone", status: "SUCCESS", durationMillis: 20_000 },
                    { id: "2", name: "Build", status: "SUCCESS", durationMillis: 30_000 },
                ],
            },
        ];

        const result = await runMonitor({
            client: fakeClient(snapshots),
            jobPath: "job/X",
            build: "1",
            baseUrl: "https://j.example",
            timeoutMs: 5_000,
            pollMs: 10,
            out,
        });

        expect(result.result).toBe("SUCCESS");
        expect(result.timedOut).toBe(false);

        const events = lines.map((l) => SafeJSON.parse(l) as { event: string; result?: string });
        const types = events.map((e) => e.event);

        expect(types[0]).toBe("start");
        expect(types).toContain("snapshot");
        expect(types).toContain("stage");
        expect(types[types.length - 1]).toBe("end");
        expect(events[events.length - 1].result).toBe("SUCCESS");
    });

    it("times out when build stays IN_PROGRESS", async () => {
        const lines: string[] = [];
        const out = (l: string) => lines.push(l.trim());

        const stuck = {
            name: "build",
            status: "IN_PROGRESS",
            startTimeMillis: 0,
            durationMillis: 1_000,
            stages: [{ id: "1", name: "Stuck", status: "IN_PROGRESS", durationMillis: 1_000 }],
        };

        const result = await runMonitor({
            client: fakeClient([stuck, stuck, stuck, stuck, stuck]),
            jobPath: "job/X",
            build: "1",
            baseUrl: "https://j.example",
            timeoutMs: 200,
            pollMs: 50,
            out,
        });

        expect(result.timedOut).toBe(true);
        expect(result.result).toBe("ABORTED");
    });

    it("emits a 'run' event when wfapi's run-level status changes", async () => {
        const lines: string[] = [];
        const out = (l: string) => lines.push(l.trim());

        const snapshots = [
            {
                name: "build",
                status: "IN_PROGRESS",
                startTimeMillis: 0,
                durationMillis: 1_000,
                stages: [{ id: "1", name: "S1", status: "IN_PROGRESS", durationMillis: 1_000 }],
            },
            {
                name: "build",
                status: "SUCCESS",
                startTimeMillis: 0,
                durationMillis: 5_000,
                stages: [{ id: "1", name: "S1", status: "SUCCESS", durationMillis: 5_000 }],
            },
        ];

        await runMonitor({
            client: fakeClient(snapshots),
            jobPath: "job/X",
            build: "1",
            baseUrl: "https://j.example",
            timeoutMs: 5_000,
            pollMs: 10,
            out,
        });

        const events = lines.map((l) => SafeJSON.parse(l) as { event: string; status?: string });
        const runStatuses = events.filter((e) => e.event === "run").map((e) => e.status);

        expect(runStatuses).toEqual(["IN_PROGRESS", "SUCCESS"]);
    });

    it("falls back to /api/json when wfapi stays IN_PROGRESS after stage deltas stop", async () => {
        const lines: string[] = [];
        const out = (l: string) => lines.push(l.trim());

        // wfapi stays IN_PROGRESS forever despite the single stage going SUCCESS
        // — classic multibranch-dispatcher lag.
        const stuck = {
            name: "build",
            status: "IN_PROGRESS",
            startTimeMillis: 0,
            durationMillis: 1_000,
            stages: [{ id: "1", name: "Dispatch", status: "SUCCESS", durationMillis: -5 }],
        };

        const result = await runMonitor({
            client: urlAwareClient({
                snapshots: [stuck],
                buildStates: [{ building: false, result: "SUCCESS", duration: 42_000 }],
            }),
            jobPath: "job/X",
            build: "1",
            baseUrl: "https://j.example",
            timeoutMs: 5_000,
            pollMs: 1, // 3 polls × 1ms ≈ <10ms before fallback fires
            out,
        });

        expect(result.timedOut).toBe(false);
        expect(result.result).toBe("SUCCESS");
        expect(result.durationMs).toBe(42_000);

        const events = lines.map((l) => SafeJSON.parse(l) as { event: string; via?: string; result?: string });
        const end = events.find((e) => e.event === "end");
        expect(end?.via).toBe("api-json");
        expect(end?.result).toBe("SUCCESS");
    });

    it("api-json fallback maps FAILURE → FAILED and emits error blocks for failed stages", async () => {
        const lines: string[] = [];
        const out = (l: string) => lines.push(l.trim());

        const stuckFailed = {
            name: "build",
            status: "IN_PROGRESS",
            startTimeMillis: 0,
            durationMillis: 1_000,
            stages: [
                {
                    id: "1",
                    name: "Compile",
                    status: "FAILED",
                    durationMillis: 10_000,
                    stageFlowNodes: [{ id: "5", name: "sh", status: "FAILED", durationMillis: 9_000 }],
                },
            ],
        };

        // The fallback path calls fetchLog → which calls /api/json for isBuildFinal,
        // then consoleFull HTML; we stub both. urlAwareClient routes by URL pattern.
        const instance = axios.create();
        instance.interceptors.request.use((cfg) => {
            cfg.adapter = async () => {
                const url = cfg.url ?? "";
                let data: unknown = "";
                let status = 200;

                if (url.includes("/blue/rest/")) {
                    data = { message: "not found" };
                    status = 404;
                } else if (url.includes("/wfapi/describe")) {
                    data = stuckFailed;
                } else if (url.endsWith("/api/json")) {
                    data = { building: false, result: "FAILURE", duration: 12_000 };
                } else if (url.includes("/log/?consoleFull") || url.includes("/log?consoleFull")) {
                    data = `<pre class="console-output">make: *** Error 1%0Aexit code 2</pre>`;
                } else if (url.includes("/wfapi/")) {
                    data = { status: "FAILED" };
                }

                return {
                    data,
                    status,
                    statusText: status === 200 ? "OK" : "Not Found",
                    headers: {},
                    config: cfg,
                    request: {},
                };
            };
            return cfg;
        });

        const result = await runMonitor({
            client: instance,
            jobPath: "job/X",
            build: "1",
            baseUrl: "https://j.example",
            timeoutMs: 5_000,
            pollMs: 1,
            out,
        });

        expect(result.result).toBe("FAILED");
        expect(result.timedOut).toBe(false);

        const events = lines.map((l) => SafeJSON.parse(l) as { event: string; via?: string; matched?: string });
        const end = events.find((e) => e.event === "end");
        expect(end?.via).toBe("api-json");
        expect(events.some((e) => e.event === "error")).toBe(true);
    });

    it("does NOT fire historical-stage notifications on first poll", async () => {
        let notifyCount = 0;
        const fakeNotifier = {
            send: async () => {
                notifyCount++;
            },
            close: () => {},
        };

        const snapshots = [
            {
                name: "build",
                status: "SUCCESS",
                startTimeMillis: 0,
                durationMillis: 50_000,
                stages: [
                    { id: "1", name: "Clone", status: "SUCCESS", durationMillis: 20_000 },
                    { id: "2", name: "Build", status: "SUCCESS", durationMillis: 30_000 },
                ],
            },
        ];

        await runMonitor({
            client: fakeClient(snapshots),
            jobPath: "job/X",
            build: "1",
            baseUrl: "https://j.example",
            timeoutMs: 5_000,
            pollMs: 10,
            notifier: fakeNotifier as never,
            out: () => {},
        });

        // Only the final "build finished" notification — no per-stage notifs for history.
        expect(notifyCount).toBe(1);
    });

    it("does not emit SUCCESS↔IN_PROGRESS flaps from negative-duration SUCCESS quirks", async () => {
        const lines: string[] = [];
        const out = (l: string) => lines.push(l.trim());

        // Jenkins multibranch parallel quirk: same node id reports SUCCESS with a
        // growing-more-negative duration, then IN_PROGRESS with a positive one,
        // then SUCCESS-negative again. After normalize, all collapse to stable
        // IN_PROGRESS until a real terminal duration arrives.
        const snapshots = [
            {
                name: "build",
                status: "IN_PROGRESS",
                startTimeMillis: 0,
                durationMillis: 60_000,
                stages: [
                    { id: "180", name: "Build", status: "SUCCESS", durationMillis: -57_751 },
                    { id: "97", name: "Tests", status: "SUCCESS", durationMillis: -35 },
                    { id: "108", name: "Tests", status: "IN_PROGRESS", durationMillis: 3_500 },
                ],
            },
            {
                name: "build",
                status: "IN_PROGRESS",
                startTimeMillis: 0,
                durationMillis: 70_000,
                stages: [
                    { id: "180", name: "Build", status: "IN_PROGRESS", durationMillis: 1_734 },
                    { id: "97", name: "Tests", status: "SUCCESS", durationMillis: -116 },
                    { id: "108", name: "Tests", status: "IN_PROGRESS", durationMillis: 12_000 },
                ],
            },
            {
                name: "build",
                status: "IN_PROGRESS",
                startTimeMillis: 0,
                durationMillis: 80_000,
                stages: [
                    { id: "180", name: "Build", status: "SUCCESS", durationMillis: -57_751 },
                    { id: "97", name: "Tests", status: "SUCCESS", durationMillis: -150 },
                    { id: "108", name: "Tests", status: "SUCCESS", durationMillis: 40_000 },
                ],
            },
            {
                name: "build",
                status: "SUCCESS",
                startTimeMillis: 0,
                durationMillis: 90_000,
                stages: [
                    { id: "180", name: "Build", status: "SUCCESS", durationMillis: 60_000 },
                    { id: "97", name: "Tests", status: "SUCCESS", durationMillis: 5_000 },
                    { id: "108", name: "Tests", status: "SUCCESS", durationMillis: 40_000 },
                ],
            },
        ];

        await runMonitor({
            client: fakeClient(snapshots),
            jobPath: "job/X",
            build: "1",
            baseUrl: "https://j.example",
            timeoutMs: 5_000,
            pollMs: 5,
            out,
        });

        const events = lines.map(
            (l) => SafeJSON.parse(l) as { event: string; id?: string; status?: string; durationMillis?: number }
        );
        const stageEvents = events.filter((e) => e.event === "stage");

        // No negative durations leak into the stream.
        for (const e of stageEvents) {
            if (e.durationMillis !== undefined) {
                expect(e.durationMillis).toBeGreaterThanOrEqual(0);
            }
        }

        // id:180 only transitions once at first sight (IN_PROGRESS) then once to SUCCESS.
        const id180 = stageEvents.filter((e) => e.id === "180").map((e) => e.status);
        expect(id180).toEqual(["IN_PROGRESS", "SUCCESS"]);

        // id:97 stays IN_PROGRESS across negative-SUCCESS polls; one SUCCESS at the end.
        const id97 = stageEvents.filter((e) => e.id === "97").map((e) => e.status);
        expect(id97).toEqual(["IN_PROGRESS", "SUCCESS"]);

        // No SUCCESS→IN_PROGRESS regressions for any stage.
        for (let i = 1; i < stageEvents.length; i++) {
            const prev = stageEvents[i - 1];
            const cur = stageEvents[i];

            if (prev.id === cur.id && prev.status === "SUCCESS") {
                expect(cur.status).not.toBe("IN_PROGRESS");
            }
        }
    });

    it("does not emit NOT_EXECUTED stages (declared-but-idle parallels)", async () => {
        const lines: string[] = [];
        const out = (l: string) => lines.push(l.trim());

        const snapshots = [
            {
                name: "build",
                status: "IN_PROGRESS",
                startTimeMillis: 0,
                durationMillis: 1_000,
                stages: [
                    { id: "1", name: "Clone", status: "SUCCESS", durationMillis: 500 },
                    { id: "2", name: "Matrix App A", status: "NOT_EXECUTED", durationMillis: 0 },
                    { id: "3", name: "Matrix App B", status: null, durationMillis: 0 },
                    { id: "4", name: "Build", status: "IN_PROGRESS", durationMillis: 200 },
                ],
            },
            {
                name: "build",
                status: "SUCCESS",
                startTimeMillis: 0,
                durationMillis: 5_000,
                stages: [
                    { id: "1", name: "Clone", status: "SUCCESS", durationMillis: 500 },
                    { id: "2", name: "Matrix App A", status: "SUCCESS", durationMillis: 2_000 },
                    { id: "3", name: "Matrix App B", status: "SUCCESS", durationMillis: 2_100 },
                    { id: "4", name: "Build", status: "SUCCESS", durationMillis: 3_000 },
                ],
            },
        ];

        await runMonitor({
            client: fakeClient(snapshots),
            jobPath: "job/X",
            build: "1",
            baseUrl: "https://j.example",
            timeoutMs: 5_000,
            pollMs: 5,
            out,
        });

        const events = lines.map((l) => SafeJSON.parse(l) as { event: string; status?: string; id?: string });
        const stageEvents = events.filter((e) => e.event === "stage");

        expect(stageEvents.every((e) => e.status !== "NOT_EXECUTED")).toBe(true);
        // null → NOT_EXECUTED is silent until real work starts → SUCCESS emits once each.
        expect(stageEvents.filter((e) => e.id === "2").map((e) => e.status)).toEqual(["SUCCESS"]);
        expect(stageEvents.filter((e) => e.id === "3").map((e) => e.status)).toEqual(["SUCCESS"]);
    });

    it("emits fee-web context on parallel stage events and notifications", async () => {
        const lines: string[] = [];
        const out = (l: string) => lines.push(l.trim());
        const sent: Array<{ title: string; subtitle: string; body: string }> = [];
        const fakeNotifier = {
            send: async (n: { title: string; subtitle: string; body: string }) => {
                sent.push({ title: n.title, subtitle: n.subtitle, body: n.body });
            },
            close: () => {},
        };

        // Minimal Blue Ocean graph: Build affected apps → PARALLEL fee-web → STAGE fee-web → Tests → Build
        const blueNodes = [
            { id: "75", displayName: "Build affected apps", type: "STAGE", firstParent: null },
            { id: "82", displayName: "fee-web", type: "PARALLEL", firstParent: "75" },
            { id: "91", displayName: "fee-web", type: "STAGE", firstParent: "82" },
            { id: "110", displayName: "Tests", type: "STAGE", firstParent: "91" },
            { id: "166", displayName: "Build", type: "STAGE", firstParent: "110" },
            { id: "12", displayName: "Clone", type: "STAGE", firstParent: null },
        ];

        const snapshots = [
            {
                name: "build",
                status: "IN_PROGRESS",
                startTimeMillis: 0,
                durationMillis: 10_000,
                stages: [
                    { id: "12", name: "Clone", status: "SUCCESS", durationMillis: 1_000 },
                    { id: "110", name: "Tests", status: "IN_PROGRESS", durationMillis: 5_000 },
                ],
            },
            {
                name: "build",
                status: "IN_PROGRESS",
                startTimeMillis: 0,
                durationMillis: 20_000,
                stages: [
                    { id: "12", name: "Clone", status: "SUCCESS", durationMillis: 1_000 },
                    { id: "110", name: "Tests", status: "SUCCESS", durationMillis: 12_000 },
                    { id: "166", name: "Build", status: "IN_PROGRESS", durationMillis: 3_000 },
                ],
            },
            {
                name: "build",
                status: "SUCCESS",
                startTimeMillis: 0,
                durationMillis: 40_000,
                stages: [
                    { id: "12", name: "Clone", status: "SUCCESS", durationMillis: 1_000 },
                    { id: "110", name: "Tests", status: "SUCCESS", durationMillis: 12_000 },
                    { id: "166", name: "Build", status: "SUCCESS", durationMillis: 25_000 },
                ],
            },
        ];

        await runMonitor({
            client: fakeClient(snapshots, blueNodes),
            jobPath: "job/Org/job/pipe/job/develop",
            build: "1",
            baseUrl: "https://j.example",
            timeoutMs: 5_000,
            pollMs: 5,
            notifier: fakeNotifier as never,
            out,
        });

        const events = lines.map(
            (l) =>
                SafeJSON.parse(l) as {
                    event: string;
                    id?: string;
                    name?: string;
                    label?: string;
                    context?: string;
                    path?: string[];
                }
        );
        const stageEvents = events.filter((e) => e.event === "stage");

        const tests = stageEvents.filter((e) => e.id === "110");
        expect(tests.length).toBeGreaterThanOrEqual(1);
        expect(tests.every((e) => e.context === "fee-web")).toBe(true);
        expect(tests.every((e) => e.label === "fee-web · Tests")).toBe(true);
        expect(tests[0].path).toEqual(["Build affected apps", "fee-web", "Tests"]);

        const buildSuccess = stageEvents.find((e) => e.id === "166" && e.label === "fee-web · Build");
        expect(buildSuccess?.context).toBe("fee-web");
        expect(buildSuccess?.path).toEqual(["Build affected apps", "fee-web", "Tests", "Build"]);

        // Notifications carry context in title, subtitle, AND body.
        const testsNotif = sent.find((n) => n.subtitle === "fee-web · Tests");
        expect(testsNotif).toBeDefined();
        expect(testsNotif?.title).toBe("develop #1 · fee-web");
        expect(testsNotif?.body).toContain("fee-web · Tests");
        expect(testsNotif?.body).toContain("SUCCESS");

        const buildNotif = sent.find((n) => n.subtitle === "fee-web · Build");
        expect(buildNotif).toBeDefined();
        expect(buildNotif?.title).toBe("develop #1 · fee-web");
        expect(buildNotif?.body).toContain("fee-web · Build");

        // Never notify with bare stage name alone as subtitle.
        expect(sent.every((n) => n.subtitle !== "Tests" && n.subtitle !== "Build")).toBe(true);
    });

    it("does not re-emit unchanged (id, status) when only duration jitter changes", async () => {
        const lines: string[] = [];
        const out = (l: string) => lines.push(l.trim());

        const base = {
            name: "build",
            status: "IN_PROGRESS" as const,
            startTimeMillis: 0,
            stages: [{ id: "108", name: "Tests", status: "SUCCESS" as const, durationMillis: 40_000 }],
        };

        // Same terminal status, duration jitter across polls (should not re-emit).
        const snapshots = [
            { ...base, durationMillis: 40_000, stages: [{ ...base.stages[0], durationMillis: 40_000 }] },
            { ...base, durationMillis: 41_000, stages: [{ ...base.stages[0], durationMillis: 40_050 }] },
            { ...base, durationMillis: 42_000, stages: [{ ...base.stages[0], durationMillis: 40_100 }] },
            {
                name: "build",
                status: "SUCCESS",
                startTimeMillis: 0,
                durationMillis: 43_000,
                stages: [{ id: "108", name: "Tests", status: "SUCCESS", durationMillis: 40_100 }],
            },
        ];

        await runMonitor({
            client: fakeClient(snapshots),
            jobPath: "job/X",
            build: "1",
            baseUrl: "https://j.example",
            timeoutMs: 5_000,
            pollMs: 5,
            out,
        });

        const events = lines.map((l) => SafeJSON.parse(l) as { event: string; id?: string });
        const stage108 = events.filter((e) => e.event === "stage" && e.id === "108");
        // First poll seeds SUCCESS into snapshot — no live stage event for already-complete.
        expect(stage108).toHaveLength(0);
        expect(events.filter((e) => e.event === "snapshot")).toHaveLength(1);
    });
});
