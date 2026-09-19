import { expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { performVerb } from "../browser/verbs";
import { createBrowserSurface } from "./browser";
import type { SurfaceSnapshot } from "./surface";

interface Call {
    name: string;
    args: Record<string, unknown>;
}

const FIXTURE_PAGES = `## Pages
0: Inbox (https://mail.example.test/inbox)
1: Jev fixture page (http://127.0.0.1:3990/) [selected]
`;

const FIXTURE_SNAPSHOT = `## Latest page snapshot
uid=1_0 RootWebArea "Jev fixture page" url="http://127.0.0.1:3990/"
  uid=1_3 link "Learn more" url="http://127.0.0.1:3990/second"
  uid=1_5 button "Export report"
  uid=1_8 textbox "Name"
  uid=1_9 button "Submit"
`;

const LOGIN_SNAPSHOT = `## Latest page snapshot
uid=2_0 RootWebArea "Sign in" url="https://example.test/login"
  uid=2_4 textbox "Email"
  uid=2_6 textbox "Password"
  uid=2_10 button "Sign in"
`;

function script(value: string): string {
    return `Script ran on page and returned:\n\`\`\`json\n${SafeJSON.stringify(value)}\n\`\`\``;
}

function fakeMcp(options: { snapshot?: string; pages?: string; fieldTypes?: Record<string, string> } = {}) {
    const calls: Call[] = [];
    const fieldTypes = options.fieldTypes ?? {};
    const door = {
        calls,
        async callTool(name: string, args: Record<string, unknown> = {}) {
            calls.push({ name, args });
            if (name === "list_pages" || name === "select_page") {
                return { content: [{ type: "text", text: options.pages ?? FIXTURE_PAGES }] };
            }

            if (name === "take_snapshot") {
                return { content: [{ type: "text", text: options.snapshot ?? FIXTURE_SNAPSHOT }] };
            }

            if (name === "evaluate_script") {
                const uids = Array.isArray(args.args) ? (args.args as string[]) : [];
                const describing = String(args.function).includes("els.map");
                const text = describing
                    ? uids.map((uid) => `${fieldTypes[uid] ?? "text"}|${uid}|${uid}|`).join("\n")
                    : "10,20,30,40,100,200,800,900,1000,1000";
                return { content: [{ type: "text", text: script(text) }] };
            }

            return { content: [{ type: "text", text: "ok" }] };
        },
        toolText(result: unknown) {
            const content = (result as { content: Array<{ text: string }> }).content;
            return content.map((block) => block.text).join("\n");
        },
        connectionId: () => 1,
        async close() {},
    };
    return door;
}

function surfaceWith(mcp: ReturnType<typeof fakeMcp>, extra: Record<string, unknown> = {}) {
    const drawn: Array<{ x: number; y: number }> = [];
    const surface = createBrowserSurface({
        port: 9222,
        mcp,
        overlay: (point) => {
            drawn.push(point);
            return true;
        },
        ...extra,
    });
    return { surface, drawn };
}

test("refuses to act when several pages are open and no selector names one", async () => {
    const mcp = fakeMcp();
    const { surface } = surfaceWith(mcp);
    await expect(surface.see()).rejects.toThrow(/2 CDP pages are open; pass --page-url/);
    expect(mcp.calls.some((call) => call.name === "select_page")).toBe(false);
    expect(mcp.calls.some((call) => call.name === "take_snapshot")).toBe(false);
});

test("--page-url selects the matching page exactly once, before the first snapshot", async () => {
    const mcp = fakeMcp();
    const { surface } = surfaceWith(mcp, { pageUrl: "127.0.0.1:3990" });
    await surface.see();
    await surface.see();
    const selects = mcp.calls.filter((call) => call.name === "select_page");
    expect(selects).toHaveLength(1);
    expect(selects[0].args).toEqual({ pageId: 1 });
    expect(mcp.calls.findIndex((call) => call.name === "select_page")).toBeLessThan(
        mcp.calls.findIndex((call) => call.name === "take_snapshot")
    );
});

test("--page-index that matches nothing names the open pages", async () => {
    const mcp = fakeMcp();
    const { surface } = surfaceWith(mcp, { pageIndex: 7 });
    await expect(surface.see()).rejects.toThrow(/No CDP page matches --page-index 7/);
});

test("a text field is a candidate only when --inputs names it", async () => {
    const without = surfaceWith(fakeMcp(), { pageUrl: "3990" });
    const plain = await without.surface.see();
    expect(plain.candidates.filter((row) => row.action === "set")).toHaveLength(0);

    const mcp = fakeMcp();
    const { surface } = surfaceWith(mcp, { pageUrl: "3990", inputs: { name: "Robin" } });
    const snapshot = await surface.see();
    const set = snapshot.candidates.filter((row) => row.action === "set");
    expect(set).toEqual([{ id: "1_8", label: "Name", element: -1, action: "set", role: "textbox" }]);

    await surface.act(snapshot, set[0]);
    const fill = mcp.calls.find((call) => call.name === "fill");
    expect(fill?.args).toEqual({ uid: "1_8", value: "Robin" });
});

test("a password page with no supplied secret yields no candidates", async () => {
    const mcp = fakeMcp({
        snapshot: LOGIN_SNAPSHOT,
        pages: `## Pages\n0: Sign in (https://example.test/login) [selected]\n`,
        fieldTypes: { "2_4": "email", "2_6": "password" },
    });
    const { surface } = surfaceWith(mcp, { pageUrl: "example.test" });
    const snapshot = await surface.see();
    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.evidence).toMatchObject({ passwordWall: true, fields: ["Password"] });
    expect(mcp.calls.some((call) => call.name === "click")).toBe(false);
});

test("a supplied password opens the same page for acting", async () => {
    const mcp = fakeMcp({
        snapshot: LOGIN_SNAPSHOT,
        pages: `## Pages\n0: Sign in (https://example.test/login) [selected]\n`,
        fieldTypes: { "2_4": "email", "2_6": "password" },
    });
    const { surface } = surfaceWith(mcp, { pageUrl: "example.test", inputs: { password: "hunter-invented" } });
    const snapshot = await surface.see();
    expect(snapshot.candidates.map((row) => row.id)).toContain("2_10");
});

test("acting twice on the same uid without a page change stops the loop", async () => {
    const mcp = fakeMcp();
    const { surface } = surfaceWith(mcp, { pageUrl: "3990" });
    const snapshot = await surface.see();
    const target = snapshot.candidates.find((row) => row.id === "1_5");
    if (!target) {
        throw new Error("the fixture snapshot lost its button");
    }

    expect(await surface.act(snapshot, target)).toEqual({ ok: true, error: undefined });
    const again = await surface.see();
    expect(again.id).toBe(snapshot.id);
    expect(await surface.act(again, target)).toEqual({ ok: false, error: "repeated_action" });
    expect(mcp.calls.filter((call) => call.name === "click")).toHaveLength(1);
});

test("a click draws the overlay at real screen coordinates", async () => {
    const mcp = fakeMcp();
    const { surface, drawn } = surfaceWith(mcp, { pageUrl: "3990" });
    const snapshot = await surface.see();
    const target = snapshot.candidates.find((row) => row.id === "1_5");
    if (!target) {
        throw new Error("the fixture snapshot lost its button");
    }

    await surface.act(snapshot, target);
    expect(drawn).toEqual([{ x: 125, y: 340 }]);
});

test("a candidate outside the snapshot never reaches the browser", async () => {
    const mcp = fakeMcp();
    const { surface } = surfaceWith(mcp, { pageUrl: "3990" });
    const snapshot = await surface.see();
    const result = await surface.act(snapshot, {
        id: "9_9",
        label: "invented",
        element: -1,
        action: "click",
    });
    expect(result.ok).toBe(false);
    expect(mcp.calls.some((call) => call.name === "click")).toBe(false);
});

test("chrome rows are choosable and reach chrome-devtools", async () => {
    const mcp = fakeMcp();
    const { surface } = surfaceWith(mcp, { pageUrl: "3990" });
    const snapshot = await surface.see();
    const back = snapshot.candidates.find((row) => row.chrome === "back");
    expect(back).toMatchObject({ action: "chrome", element: -1 });
    if (!back) {
        throw new Error("the browser surface offered no chrome verbs");
    }

    expect(await surface.act(snapshot, back)).toEqual({ ok: true, error: undefined });
    expect(mcp.calls.find((call) => call.name === "navigate_page")?.args).toEqual({ type: "back" });
});

function verbMcp() {
    const calls: Call[] = [];
    return {
        calls,
        async callTool(name: string, args: Record<string, unknown> = {}) {
            calls.push({ name, args });
            return { content: [{ type: "text", text: "done" }] };
        },
        toolText: () => "done",
        connectionId: () => 1,
        async close() {},
    };
}

test("every verb reaches exactly one MCP tool and an unknown verb reaches none", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
        [{ verb: "click", uid: "1_5" }, "click"],
        [{ verb: "fill", uid: "1_8", value: "Robin" }, "fill"],
        [{ verb: "select", uid: "1_7", value: "Pro" }, "fill"],
        [{ verb: "back" }, "navigate_page"],
        [{ verb: "reload" }, "navigate_page"],
        [{ verb: "scroll_down" }, "evaluate_script"],
        [{ verb: "scroll_up" }, "evaluate_script"],
        [{ verb: "wait" }, "evaluate_script"],
        [
            { verb: "navigate", url: "https://example.test/next", pageUrl: "https://example.test/start" },
            "navigate_page",
        ],
    ];
    for (const [request, tool] of cases) {
        const mcp = verbMcp();
        const result = await performVerb({ mcp, request: request as { verb: string } });
        expect({ verb: request.verb, ...result }).toMatchObject({ verb: request.verb, ok: true });
        expect(mcp.calls.map((call) => call.name)).toEqual([tool]);
    }

    const unknown = verbMcp();
    expect(await performVerb({ mcp: unknown, request: { verb: "purchase" } })).toEqual({
        ok: false,
        error: "unsupported_verb: purchase",
    });
    expect(unknown.calls).toEqual([]);
});

test("a verb without the input it needs refuses instead of reaching the browser", async () => {
    for (const request of [
        { verb: "click" },
        { verb: "fill", uid: "1_8" },
        { verb: "navigate" },
        { verb: "navigate", url: "https://elsewhere.test/", pageUrl: "https://example.test/start" },
    ]) {
        const mcp = verbMcp();
        const result = await performVerb({ mcp, request });
        expect(result.ok).toBe(false);
        expect(mcp.calls).toEqual([]);
    }
});

test("the surface tolerates the auto surface's cdp: prefix on snapshot rows", async () => {
    const mcp = fakeMcp();
    const { surface } = surfaceWith(mcp, { pageUrl: "3990" });
    const snapshot = await surface.see();
    const merged: SurfaceSnapshot = {
        ...snapshot,
        candidates: snapshot.candidates.map((row) => ({ ...row, id: `cdp:${row.id}` })),
    };
    const result = await surface.act(merged, { id: "1_5", label: "Export report", element: -1, action: "click" });
    expect(result.ok).toBe(true);
});

test("a reconnected session re-selects the target page before the next snapshot", async () => {
    const mcp = fakeMcp();
    let connection = 1;
    const reconnecting = { ...mcp, connectionId: () => connection };
    const { surface } = surfaceWith(reconnecting, { pageUrl: "3990" });
    await surface.see();
    connection = 2;
    await surface.see();
    const selects = mcp.calls.filter((call) => call.name === "select_page");
    expect(selects).toHaveLength(2);
    expect(selects[1].args).toEqual({ pageId: 1 });
});

test("a field that already holds the supplied value is no longer a candidate", async () => {
    const filled = `## Latest page snapshot
uid=1_0 RootWebArea "Jev fixture page" url="http://127.0.0.1:3990/"
  uid=1_8 textbox "Name" value="Robin"
  uid=1_9 button "Submit"
`;
    const mcp = fakeMcp({ snapshot: filled });
    const { surface } = surfaceWith(mcp, { pageUrl: "3990", inputs: { name: "Robin" } });
    const snapshot = await surface.see();
    expect(snapshot.candidates.filter((row) => row.action === "set")).toEqual([]);
    expect(snapshot.candidates.map((row) => row.id)).toContain("1_9");
});
