import { describe, expect, test } from "bun:test";
import {
    activateApp,
    ancestorPids,
    frontmostTarget,
    isBrowserApp,
    parseParentTable,
    pickFrontWindow,
    switchableApps,
} from "./frontmost";

const PS = `
    1     0
  400     1
  410   400
  420   410
  430   420
  900     1
`;

describe("frontmost target", () => {
    test("ancestorPids walks the parent chain from one ps table and stops at launchd", () => {
        const table = parseParentTable(PS);
        expect([...ancestorPids(430, table)].sort()).toEqual([400, 410, 420]);
        expect([...ancestorPids(900, table)]).toEqual([]);
    });

    test("pickFrontWindow skips our own process chain and system owners, front to back", () => {
        const windows = [
            { pid: 410, app: "cmux", title: "shell" },
            { pid: 77, app: "Dock" },
            { pid: 88, app: "Brave Browser", title: "GitLab", windowId: 12 },
            { pid: 99, app: "Calculator" },
        ];
        expect(pickFrontWindow(windows, { excludePids: new Set([400, 410, 420]) })?.app).toBe("Brave Browser");
        expect(pickFrontWindow(windows.slice(0, 2), { excludePids: new Set([410]) })).toBeNull();
    });

    test("the WindowServer's focused app beats window z-order, which a raised window can mislead", () => {
        const windows = [
            { pid: 410, app: "cmux", title: "shell" },
            { pid: 88, app: "ChatGPT", title: "ChatGPT" },
            { pid: 99, app: "Brave Browser", title: "Rohlik" },
        ];
        const excludePids = new Set([400, 410, 420]);

        expect(pickFrontWindow(windows, { excludePids })?.app).toBe("ChatGPT");
        expect(pickFrontWindow(windows, { excludePids, preferPid: 99 })?.app).toBe("Brave Browser");
    });

    test("a focused pid that is our own terminal, or has no usable window, falls back to z-order", () => {
        const windows = [
            { pid: 410, app: "cmux", title: "shell" },
            { pid: 88, app: "ChatGPT", title: "ChatGPT" },
        ];
        const excludePids = new Set([410]);

        expect(pickFrontWindow(windows, { excludePids, preferPid: 410 })?.app).toBe("ChatGPT");
        expect(pickFrontWindow(windows, { excludePids, preferPid: 7777 })?.app).toBe("ChatGPT");
    });

    test("isBrowserApp knows the browsers whose tab strip lives in scope chrome", () => {
        expect(isBrowserApp("Brave Browser")).toBe(true);
        expect(isBrowserApp("Calculator")).toBe(false);
    });

    test("frontmostTarget reads ax-tool front and returns null on a failed run", async () => {
        const picked = await frontmostTarget({
            run: async () => ({
                ok: true,
                frontmostPid: 5,
                windows: [
                    { pid: process.pid, app: "self" },
                    { pid: 5, app: "Notes", title: "Todo" },
                ],
            }),
        });
        expect(picked).toEqual({ pid: 5, app: "Notes", title: "Todo", focused: true });

        const guessed = await frontmostTarget({
            run: async () => ({
                ok: true,
                frontmostPid: process.pid,
                windows: [
                    { pid: process.pid, app: "self" },
                    { pid: 5, app: "Notes", title: "Todo" },
                ],
            }),
        });
        expect(guessed).toEqual({ pid: 5, app: "Notes", title: "Todo", focused: false });

        const failed = await frontmostTarget({ run: async () => ({ ok: false, error: "no trust" }) });
        expect(failed).toBeNull();
    });

    test("switchableApps offers one row per on-screen app, ours and the system UI excluded", async () => {
        const apps = await switchableApps({
            run: async () => ({
                ok: true,
                windows: [
                    { pid: process.pid, app: "self" },
                    { pid: 77, app: "Dock" },
                    { pid: 59814, app: "Brave Browser", title: "Twitch" },
                    { pid: 59814, app: "Brave Browser", title: "another window" },
                    { pid: 98406, app: "Calculator" },
                ],
            }),
        });

        expect(apps).toEqual([
            { pid: 59814, app: "Brave Browser", title: "Twitch" },
            { pid: 98406, app: "Calculator", title: undefined },
        ]);
    });

    test("an activation that did not take is a failure, not a success", async () => {
        expect(await activateApp(42, { run: async () => ({ ok: true, frontmostPid: 42 }) })).toEqual({ ok: true });

        const missed = await activateApp(42, { run: async () => ({ ok: true, frontmostPid: 99 }) });
        expect(missed.ok).toBe(false);
        expect(missed.error).toContain("99 is frontmost");

        const failed = await activateApp(42, { run: async () => ({ ok: false, error: "no such pid" }) });
        expect(failed).toEqual({ ok: false, error: "no such pid" });
    });
});
