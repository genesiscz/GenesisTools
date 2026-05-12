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
