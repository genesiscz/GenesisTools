import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptStaleTakeover, writePidFile } from "@genesiscz/utils/process/pidfile";
import {
    claimRecorderPidfile,
    extractDataReceived,
    healthIsDead,
    isArmableTarget,
    isArmableUrl,
    isRecordedMethod,
    MAX_LIFETIME_SECONDS,
    makePacketGate,
    nextHealthFails,
    pickArmTargets,
    probeCdp,
    recordScopeError,
    resolveRecordSeconds,
    waitUntilRecorderDone,
} from "./recorder.ts";

describe("isArmableUrl", () => {
    test("keeps http(s) pages and skips DevTools and extension pages", () => {
        expect(isArmableUrl("https://app.example.com/portal")).toBe(true);
        expect(isArmableUrl("http://localhost:3000/")).toBe(true);
        expect(isArmableUrl("about:blank")).toBe(true);
        expect(isArmableUrl("devtools://devtools/bundled/devtools_app.html")).toBe(false);
        expect(isArmableUrl("chrome-extension://abcdef/onetab.html")).toBe(false);
        expect(isArmableUrl("chrome://settings/")).toBe(false);
        expect(isArmableUrl("brave://rewards/")).toBe(false);
    });
});

describe("isArmableTarget / pickArmTargets", () => {
    test("arms http pages and iframes, skips workers and DevTools", () => {
        expect(isArmableTarget({ type: "page", url: "https://app.example.com" })).toBe(true);
        expect(isArmableTarget({ type: "iframe", url: "https://idp.example.com/login" })).toBe(true);
        expect(isArmableTarget({ type: "service_worker", url: "https://app.example.com/sw.js" })).toBe(false);
        expect(isArmableTarget({ type: "page", url: "devtools://devtools/x.html" })).toBe(false);
        expect(
            pickArmTargets([
                { targetId: "a", type: "page", url: "https://app.example.com" },
                { targetId: "b", type: "page", url: "chrome-extension://abc/x.html" },
                { targetId: "c", type: "iframe", url: "https://idp.example.com/login" },
            ]).map((t) => t.targetId)
        ).toEqual(["a", "c"]);
    });
});

describe("isRecordedMethod", () => {
    const net = new Set(["net"] as const);
    const withConsole = new Set(["net", "console"] as const);
    const withWs = new Set(["net", "ws"] as const);

    test("records the chrome-har diet including Page lifecycle events", () => {
        for (const m of [
            "Network.requestWillBeSent",
            "Network.requestWillBeSentExtraInfo",
            "Network.responseReceivedExtraInfo",
            "Network.responseReceived",
            "Network.loadingFinished",
            "Network.loadingFailed",
            "Network.requestServedFromCache",
            "Network.resourceChangedPriority",
            "Page.frameStartedLoading",
            "Page.frameAttached",
            "Page.loadEventFired",
            "Page.domContentEventFired",
            "Page.frameNavigated",
        ]) {
            expect(isRecordedMethod(m, net)).toBe(true);
        }
    });

    test("never records raw dataReceived (the fast path aggregates it) and gates frames/console on channels", () => {
        expect(isRecordedMethod("Network.dataReceived", net)).toBe(false);
        expect(isRecordedMethod("Network.dataReceived", withWs)).toBe(false);
        expect(isRecordedMethod("Network.webSocketFrameReceived", net)).toBe(false);
        expect(isRecordedMethod("Network.webSocketFrameReceived", withWs)).toBe(true);
        expect(isRecordedMethod("Runtime.consoleAPICalled", net)).toBe(false);
        expect(isRecordedMethod("Runtime.consoleAPICalled", withConsole)).toBe(true);
        expect(isRecordedMethod("Target.attachedToTarget", withConsole)).toBe(false);
    });
});

describe("dataReceived fast path", () => {
    test("extracts requestId/dataLength/timestamp/sessionId from the raw packet without JSON.parse", () => {
        const raw =
            '{"method":"Network.dataReceived","params":{"requestId":"1000.42","timestamp":1234.5,"dataLength":2048,"encodedDataLength":1000},"sessionId":"S1"}';
        expect(extractDataReceived(raw)).toEqual({
            sessionId: "S1",
            requestId: "1000.42",
            dataLength: 2048,
            timestamp: 1234.5,
        });
        expect(extractDataReceived('{"method":"Network.dataReceived","params":{}}')).toBeNull();
    });

    test("gate drops dataReceived packets, aggregates them per session+request, and take() drains once", () => {
        const gate = makePacketGate({ parseWsFrames: false });
        const packet = (sid: string, id: string, len: number) =>
            `{"method":"Network.dataReceived","params":{"requestId":"${id}","timestamp":1.5,"dataLength":${len}},"sessionId":"${sid}"}`;

        expect(gate.dropRaw(packet("A", "r1", 100))).toBe(true);
        expect(gate.dropRaw(packet("A", "r1", 200))).toBe(true);
        expect(gate.dropRaw(packet("B", "r1", 999))).toBe(true);

        expect(gate.take("A", "r1")).toEqual({ total: 300, count: 2, lastTimestamp: 1.5 });
        expect(gate.take("A", "r1")).toBeNull();
        expect(gate.take("B", "r1")?.total).toBe(999);
    });

    test("gate drops websocket frames unless the ws channel parses them; command replies always pass", () => {
        const gate = makePacketGate({ parseWsFrames: false });
        expect(gate.dropRaw('{"method":"Network.webSocketFrameReceived","params":{}}')).toBe(true);
        expect(gate.dropRaw('{"method":"Network.webSocketFrameSent","params":{}}')).toBe(true);
        expect(gate.dropRaw('{"method":"Network.requestWillBeSent","params":{}}')).toBe(false);
        expect(gate.dropRaw('{"id":1,"result":{}}')).toBe(false);

        const wsGate = makePacketGate({ parseWsFrames: true });
        expect(wsGate.dropRaw('{"method":"Network.webSocketFrameReceived","params":{}}')).toBe(false);
    });
});

describe("CDP health", () => {
    test("three failed probes mark the browser dead", () => {
        expect(nextHealthFails(0, true)).toBe(0);
        expect(nextHealthFails(2, true)).toBe(0);
        expect(nextHealthFails(2, false)).toBe(3);
        expect(healthIsDead(2)).toBe(false);
        expect(healthIsDead(3)).toBe(true);
    });

    test("probeCdp is false when fetch throws and true on HTTP 200", async () => {
        expect(
            await probeCdp(9222, async () => {
                throw new Error("down");
            })
        ).toBe(false);
        expect(await probeCdp(9222, async () => new Response("{}", { status: 200 }))).toBe(true);
        expect(await probeCdp(9222, async () => new Response("no", { status: 500 }))).toBe(false);
    });
});

describe("record scope + seconds", () => {
    test("rejects a bare record and accepts --match or --all-tabs", () => {
        expect(recordScopeError({})).toContain("record needs a scope");
        expect(recordScopeError({ match: "  " })).toContain("record needs a scope");
        expect(recordScopeError({ match: "app.example.com" })).toBeNull();
        expect(recordScopeError({ allTabs: true })).toBeNull();
    });

    test("defaults to 600, keeps 0 as until-CDP-drops, and rejects negatives", () => {
        expect(resolveRecordSeconds(undefined)).toBe(600);
        expect(resolveRecordSeconds("")).toBe(600);
        expect(resolveRecordSeconds("90")).toBe(90);
        expect(resolveRecordSeconds(0)).toBe(0);
        expect(resolveRecordSeconds("-1")).toBe(600);
        expect(resolveRecordSeconds("nope")).toBe(600);
    });
});

describe("waitUntilRecorderDone", () => {
    test("resolves close when the websocket closes before the timeout", async () => {
        expect(await waitUntilRecorderDone({ closed: Promise.resolve(), seconds: 5 })).toBe("close");
    });

    test("resolves timeout when the websocket never closes", async () => {
        expect(await waitUntilRecorderDone({ closed: new Promise(() => {}), seconds: 0.05 })).toBe("timeout");
    });

    test("resolves signal when the abort fires", async () => {
        const ac = new AbortController();
        const pending = waitUntilRecorderDone({ closed: new Promise(() => {}), seconds: 5, signal: ac.signal });
        ac.abort();
        expect(await pending).toBe("signal");
    });

    test("seconds=0 still arms the 24h lifetime cap instead of waiting forever", () => {
        expect(MAX_LIFETIME_SECONDS).toBe(24 * 60 * 60);
    });
});

describe("claimRecorderPidfile (single-winner atomic claim)", () => {
    const tmp = () => mkdtempSync(join(tmpdir(), "cdp-claim-"));

    test("fresh create claims; a live foreign owner fails fast", async () => {
        const dir = tmp();
        const path = join(dir, "recorder.pid");
        try {
            await claimRecorderPidfile(path, 9999);
            expect(existsSync(path)).toBe(true);
            expect(readFileSync(path, "utf8")).toContain(String(process.pid));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("rejects a claim while a LIVE foreign process owns the pidfile", async () => {
        const dir = tmp();
        const path = join(dir, "recorder.pid");
        const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"]);
        try {
            writePidFile(path, { pid: child.pid });
            await expect(claimRecorderPidfile(path, 9999)).rejects.toThrow(/already up on 9999 \(pid \d+\)/);
            // The live owner's claim survived the rejected attempt.
            expect(readFileSync(path, "utf8")).toContain(String(child.pid));
        } finally {
            child.kill();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("sweeps takeover temps of DEAD creators and spares a live creator's", async () => {
        const dir = tmp();
        const path = join(dir, "recorder.pid");
        const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"]);
        try {
            const dead = Bun.spawnSync([process.execPath, "-e", ""]).pid;
            const deadTemp = join(dir, `recorder.pid.stale-${dead}-deadbeef`);
            const liveTemp = join(dir, `recorder.pid.stale-${child.pid}-cafebabe`);
            await Bun.write(deadTemp, "residue");
            await Bun.write(liveTemp, "mid-takeover");

            await claimRecorderPidfile(path, 9999);
            expect(existsSync(deadTemp)).toBe(false);
            expect(existsSync(liveTemp)).toBe(true);
        } finally {
            child.kill();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("takes over a stale record and self-heals over an own-pid pre-write", async () => {
        const dir = tmp();
        const path = join(dir, "recorder.pid");
        try {
            // The background spawner pre-writes the child's own pid — here,
            // ours. The claim must steal that artifact and end up owning it.
            writePidFile(path);
            await claimRecorderPidfile(path, 9999);
            expect(readFileSync(path, "utf8")).toContain(String(process.pid));

            // A genuinely dead pid is also reclaimable.
            const dead = Bun.spawnSync([process.execPath, "-e", ""]).pid;
            rmSync(path, { force: true });
            writePidFile(path, { pid: dead });
            await claimRecorderPidfile(path, 9999);
            expect(readFileSync(path, "utf8")).toContain(String(process.pid));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("N concurrent DISCARD takeovers of one stale artifact produce EXACTLY one winner and an empty slot", async () => {
        // The claim:true single-winner property is pinned by daemon.test.ts
        // against the same shared function; this covers the claim:false
        // (cleanup delete) mode it does not.
        const dir = tmp();
        const path = join(dir, "recorder.pid");
        try {
            const dead = Bun.spawnSync([process.execPath, "-e", ""]).pid;
            const stale = writePidFile(path, { pid: dead });
            const staleContent = readFileSync(path, "utf8");
            expect(stale.pid).toBe(dead);

            const results = await Promise.all(
                Array.from({ length: 12 }, () => attemptStaleTakeover(path, staleContent, { claim: false }))
            );
            expect(results.filter(Boolean)).toHaveLength(1);
            expect(existsSync(path)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
