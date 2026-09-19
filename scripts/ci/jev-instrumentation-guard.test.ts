import { describe, expect, test } from "bun:test";
import { scanSource } from "./jev-instrumentation-guard";

const PLANTED = `
async function judge(evaluate: (q: unknown) => Promise<unknown>) {
    return await evaluate({ question: 1 });
}
`;

const INSTRUMENTED = `
const prof = profiler.scope("jev-route");
async function judge(evaluate: (q: unknown) => Promise<unknown>) {
    const stop = prof.start("judge");
    try {
        return await evaluate({ question: 1 });
    } finally {
        stop();
    }
}
`;

const NESTED_CALLBACK = `
const prof = profiler.scope("jev-observe");
async function fanout(items: unknown[], evaluate: (q: unknown) => Promise<unknown>) {
    return prof.measureAsync("fanout", () => Promise.all(items.map((item) => evaluate(item))));
}
`;

const SOCKET = `
function open(url: string) {
    const socket = new WebSocket(url);
    return socket;
}
`;

const MODULE_LEVEL = `
const result = await evaluate({ question: 1 });
`;

const METHOD = `
class Door {
    async see(session: { callTool(name: string): Promise<string> }) {
        return session.callTool("take_snapshot");
    }
}
`;

describe("jev-instrumentation-guard", () => {
    test("catches a planted evaluate() with no profiler measurement", () => {
        const findings = scanSource(PLANTED, "planted.ts");
        expect(findings).toEqual([{ file: "planted.ts", line: 3, call: "evaluate(", fn: "judge" }]);
    });

    test("an instrumented function passes", () => {
        expect(scanSource(INSTRUMENTED, "ok.ts")).toEqual([]);
    });

    test("a callback inside an instrumented function is covered by its parent", () => {
        expect(scanSource(NESTED_CALLBACK, "nested.ts")).toEqual([]);
    });

    test("catches new WebSocket() and a method call on a session", () => {
        expect(scanSource(SOCKET, "socket.ts").map((f) => f.call)).toEqual(["new WebSocket("]);
        expect(scanSource(METHOD, "method.ts")).toEqual([{ file: "method.ts", line: 4, call: "callTool(", fn: "see" }]);
    });

    test("a module-level call is not a function and is skipped", () => {
        expect(scanSource(MODULE_LEVEL, "module.ts")).toEqual([]);
    });
});

test("an exemption needs a stated reason, and covers only its own call", () => {
    const planted = `
async function forwards(mcp: { callTool: (name: string) => Promise<void> }) {
    // jev-instrumentation-ignore: a thin forwarder; its caller owns the timer
    await mcp.callTool("list_pages");
    await mcp.callTool("take_snapshot");
}
`;
    const findings = scanSource(planted, "planted.ts");
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(5);
});

test("a bare ignore comment with no reason is not an exemption", () => {
    const planted = `
async function forwards(mcp: { callTool: (name: string) => Promise<void> }) {
    // jev-instrumentation-ignore:
    await mcp.callTool("list_pages");
}
`;
    expect(scanSource(planted, "planted.ts")).toHaveLength(1);
});

test("an end-of-line exemption works too", () => {
    const planted = `
async function forwards(mcp: { callTool: (name: string) => Promise<void> }) {
    await mcp.callTool("list_pages"); // jev-instrumentation-ignore: measured by the caller
}
`;
    expect(scanSource(planted, "planted.ts")).toEqual([]);
});
