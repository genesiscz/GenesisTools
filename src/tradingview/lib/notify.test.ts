import { describe, expect, test } from "bun:test";
import { notifySignal } from "./notify";
import type { SignalEvent } from "./types";

const EVENT: SignalEvent = {
    time: 1781037360,
    barIndex: 1,
    plotId: "plot_1",
    plotTitle: "Buy",
    value: 1,
    kind: "live",
};

describe("notifySignal", () => {
    test("spawns say and exec with TV_SIGNAL env", () => {
        const calls: Array<{ cmd: string[]; env?: Record<string, string> }> = [];
        notifySignal(EVENT, "BYBIT:BTCUSDT.P", { say: true, exec: "echo hi" }, (cmd, env) => {
            calls.push({ cmd, env });
        });
        const sayCall = calls.find((c) => c.cmd[0] === "tools");
        const execCall = calls.find((c) => c.cmd[0] === "sh");
        expect(sayCall?.cmd.join(" ")).toContain("Buy");
        expect(execCall?.env?.TV_SIGNAL).toContain('"plotTitle":"Buy"');
    });

    test("does nothing when no channels enabled", () => {
        const calls: string[][] = [];
        notifySignal(EVENT, "X", {}, (cmd) => {
            calls.push(cmd);
        });
        expect(calls).toEqual([]);
    });
});