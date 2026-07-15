import { describe, expect, test } from "bun:test";
import { applyClassifyCache, clearClassifyCache, portIdentity, rememberClassify } from "./classify-cache";
import type { PortInfo } from "./types";

const base = {
    port: 3042,
    pid: 1,
    command: "bun",
    fullCommand: "bun x",
    startedAt: "2026-01-01T00:00:00.000Z",
    address: "127.0.0.1",
    proto: "tcp4" as const,
};

describe("portIdentity", () => {
    test("same fields match; pid change differs", () => {
        expect(portIdentity(base)).toBe(portIdentity({ ...base }));
        expect(portIdentity(base)).not.toBe(portIdentity({ ...base, pid: 2 }));
    });
});

describe("classify cache", () => {
    test("apply after remember promotes pending to done", () => {
        clearClassifyCache();
        const done: PortInfo = {
            ...base,
            kind: "web",
            isWebapp: true,
            probeStatus: "done",
            title: "App",
        };
        rememberClassify([done]);

        const pending: PortInfo = { ...base, probeStatus: "pending", title: "App" };
        const applied = applyClassifyCache([pending]);
        expect(applied[0].probeStatus).toBe("done");
        expect(applied[0].kind).toBe("web");
        expect(applied[0].isWebapp).toBe(true);
    });

    test("different identity stays pending", () => {
        clearClassifyCache();
        rememberClassify([{ ...base, kind: "web", probeStatus: "done" }]);
        const other: PortInfo = { ...base, pid: 99, probeStatus: "pending" };
        expect(applyClassifyCache([other])[0].probeStatus).toBe("pending");
    });
});
