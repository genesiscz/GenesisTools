import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import axios from "axios";
import { runMonitor } from "./monitor";

function fakeClient(snapshots: unknown[]) {
    let i = 0;
    const instance = axios.create();
    instance.interceptors.request.use((cfg) => {
        cfg.adapter = async () => {
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
}) {
    let snapIdx = 0;
    let stateIdx = 0;
    const instance = axios.create();
    instance.interceptors.request.use((cfg) => {
        cfg.adapter = async () => {
            const url = cfg.url ?? "";
            let data: unknown;

            if (url.includes("/wfapi/describe")) {
                data = routes.snapshots[Math.min(snapIdx++, routes.snapshots.length - 1)];
            } else if (url.endsWith("/api/json")) {
                const states = routes.buildStates ?? [{ building: true, result: null, duration: 0 }];
                data = states[Math.min(stateIdx++, states.length - 1)];
            } else {
                throw new Error(`unexpected url: ${url}`);
            }

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

                if (url.includes("/wfapi/describe")) {
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
                    status: 200,
                    statusText: "OK",
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
});
