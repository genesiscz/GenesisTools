import type { BuildLogSubscription, ClassifiedLogEntry, DashboardClient } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { type BuildLogStatus, openBuildLogSubscription } from "@/features/build-log-tail/subscription";

interface FakeControl {
    emit: (entry: ClassifiedLogEntry) => void;
    closed: () => boolean;
    client: DashboardClient;
    logFile: () => string | null;
}

function fakeClient(): FakeControl {
    let handler: ((e: ClassifiedLogEntry) => void) | null = null;
    let isClosed = false;
    let lf: string | null = null;
    const client = {
        buildLog: {
            subscribe: (logFile: string, onEntry: (e: ClassifiedLogEntry) => void): BuildLogSubscription => {
                lf = logFile;
                handler = onEntry;
                return {
                    close() {
                        isClosed = true;
                    },
                };
            },
        },
    } as unknown as DashboardClient;
    return { client, closed: () => isClosed, emit: (e) => handler?.(e), logFile: () => lf };
}

const line = (data: string, cls: ClassifiedLogEntry["cls"] = "info"): ClassifiedLogEntry =>
    ({ type: "stdout", ts: `t-${data}`, data, cls }) as ClassifiedLogEntry;

describe("openBuildLogSubscription", () => {
    it("passes the logFile to the seam and forwards each new line", () => {
        const ctrl = fakeClient();
        const got: string[] = [];
        openBuildLogSubscription(ctrl.client, "sync/x.jsonl", { onLine: (l) => got.push(l.type === "stdout" ? l.data : "") });
        expect(ctrl.logFile()).toBe("sync/x.jsonl");
        ctrl.emit(line("a"));
        ctrl.emit(line("b"));
        expect(got).toEqual(["a", "b"]);
    });

    it("dedupes a re-delivered line by composite key (ts+data)", () => {
        const ctrl = fakeClient();
        const got: string[] = [];
        openBuildLogSubscription(ctrl.client, "f", { onLine: (l) => got.push(l.type === "stdout" ? l.data : "") });
        ctrl.emit(line("a"));
        ctrl.emit(line("a"));
        ctrl.emit(line("b"));
        expect(got).toEqual(["a", "b"]);
    });

    it("reports connecting → open on subscribe, then live on the first line", () => {
        const ctrl = fakeClient();
        const statuses: BuildLogStatus[] = [];
        openBuildLogSubscription(ctrl.client, "f", { onLine: () => {}, onStatus: (s) => statuses.push(s) });
        expect(statuses).toEqual(["connecting", "open"]);
        ctrl.emit(line("a"));
        expect(statuses).toEqual(["connecting", "open", "live"]);
    });

    it("close() tears down the underlying subscription and is idempotent", () => {
        const ctrl = fakeClient();
        const handle = openBuildLogSubscription(ctrl.client, "f", { onLine: () => {} });
        expect(ctrl.closed()).toBe(false);
        handle.close();
        handle.close();
        expect(ctrl.closed()).toBe(true);
    });

    it("drops lines that arrive after close()", () => {
        const ctrl = fakeClient();
        const got: string[] = [];
        const handle = openBuildLogSubscription(ctrl.client, "f", { onLine: (l) => got.push(l.type === "stdout" ? l.data : "") });
        ctrl.emit(line("a"));
        handle.close();
        ctrl.emit(line("b"));
        expect(got).toEqual(["a"]);
    });
});
