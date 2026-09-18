import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createComputerMcpServer } from "../../mcp/server";
import { ComputerReplEngine } from "./repl";
import { ComputerUse, type NativeBridge } from "./session";

function fixture() {
    const snapshot = {
        ok: true,
        app: "Fixture",
        pid: 7,
        processLaunch: 123,
        scope: "window",
        snapshot: "s0",
        window: { id: 10, title: "Fixture", x: -500, y: 100, width: 400, height: 300 },
        screenshot: { path: "/fixture.png", width: 800, height: 600 },
        elements: [
            { index: 0, depth: 0, role: "AXWindow", actions: ["AXRaise"], x: -500, y: 100, width: 400, height: 300 },
            {
                index: 1,
                depth: 1,
                role: "AXButton",
                AXTitle: "Save",
                AXIdentifier: "save",
                actions: ["AXPress", "AXShowMenu"],
            },
            {
                index: 2,
                depth: 1,
                role: "AXTextField",
                AXIdentifier: "name",
                AXValue: "old",
                AXFocused: true,
                valueSettable: true,
            },
            {
                index: 3,
                depth: 1,
                role: "AXTextField",
                AXSubrole: "AXSecureTextField",
                AXValue: "SECRET",
                AXSelectedText: "SECRET",
            },
        ],
    };
    const calls: string[][] = [];
    const native: NativeBridge = {
        run: async ({ args }) => {
            calls.push(args);
            if (args[0] === "apps") {
                return { ok: true, apps: [{ pid: 7, name: "Fixture", bundleId: "example.fixture", frontmost: true }] };
            }
            if (args[0] === "see") {
                snapshot.scope = args[args.indexOf("--scope") + 1];
                return structuredClone(snapshot);
            }
            const action = args[args.indexOf("--action") + 1];
            if (action === "set") {
                snapshot.elements[2].AXValue = args[args.indexOf("--value") + 1];
            }
            snapshot.snapshot = `s${calls.length}`;
            return {
                ok: true,
                after: structuredClone(snapshot),
                clipboardRestore: action === "paste" ? "restored" : undefined,
            };
        },
    };
    return { calls, native, computer: new ComputerUse({ native }), snapshot };
}
describe("independent Computer Use session", () => {
    test("retains state, returns differences and masks secure values", async () => {
        const { computer, snapshot } = fixture();
        const first = await computer.get_app_state({ app: "Fixture", image: false });
        expect(first.text).not.toContain("SECRET");
        expect(first.elements[3].value).toBe("[secure]");
        snapshot.elements[1].AXTitle = "Save changes";
        const next = await computer.get_app_state({ app: "Fixture", image: false });
        expect(next.revision).not.toBe(first.revision);
        expect(next.changes?.added).toHaveLength(1);
        expect(next.text).toContain("Save changes");
        expect(computer.find({ app: "Fixture", query: "save" }).elements[0].ref).toBe(next.elements[1].ref);
    });
    test("dispatches observed AXPress and refuses old refs or implicit reuse", async () => {
        const { computer, calls } = fixture();
        const state = await computer.get_app_state({ app: "Fixture", image: false });
        const click = await computer.click({ app: "Fixture", element_ref: state.elements[1].ref });
        expect(click.ok).toBe(true);
        expect(click.action.native).toBe("press");
        expect(calls[1]).toContain("--no-image");
        await expect(computer.click({ app: "Fixture", element_ref: state.elements[1].ref })).rejects.toThrow(
            "different observation"
        );
        await expect(computer.click({ app: "Fixture", element_index: 1 })).rejects.toThrow("After an action");
        expect(calls).toHaveLength(2);
        expect(click.state).toBeDefined();
        const next = await computer.click({ app: "Fixture", element_ref: click.state!.elements[1].ref });
        expect(next.ok).toBe(true);
    });
    test("converts source pixels to Retina screen coordinates with a negative origin", async () => {
        const { computer, calls } = fixture();
        await computer.get_app_state({ app: "Fixture" });
        await computer.click({ app: "Fixture", x: 200, y: 100 });
        expect(calls[1]).toContain("-400,150");
        expect(calls[1]).toContain("--background");
        const state = await computer.get_app_state({ app: "Fixture" });
        await expect(computer.click({ app: "Fixture", revision: state.revision, x: 801, y: 10 })).rejects.toThrow(
            "outside"
        );
        expect(calls).toHaveLength(3);
    });
    test("literal values, context selection and normalized secondary actions keep native argv separate", async () => {
        const { computer, calls } = fixture();
        let state = await computer.get_app_state({ app: "Fixture", image: false });
        let result = await computer.set_value({
            app: "Fixture",
            element_ref: state.elements[2].ref,
            value: "--background",
        });
        expect(calls[1].slice(calls[1].indexOf("--value"), calls[1].indexOf("--value") + 2)).toEqual([
            "--value",
            "--background",
        ]);
        state = result.state!;
        result = await computer.select_text({
            app: "Fixture",
            element_ref: state.elements[2].ref,
            text: "background",
            prefix: "--",
            selection_type: "cursor_after",
        });
        expect(calls[2]).toContain("cursor_after");
        state = result.state!;
        await computer.perform_secondary_action({
            app: "Fixture",
            element_ref: state.elements[1].ref,
            action: "show_menu",
        });
        expect(calls[3]).toContain("AXShowMenu");
        const fresh = await computer.get_app_state({ app: "Fixture", image: false });
        await expect(
            computer.perform_secondary_action({
                app: "Fixture",
                element_ref: fresh.elements[1].ref,
                action: "launch anything",
            })
        ).rejects.toThrow("exposed");
    });
    test("focused typing and app key aliases use snapshot-scoped input without global fallback", async () => {
        const { computer, calls } = fixture();
        const state = await computer.get_app_state({ app: "Fixture", image: false });
        const typed = await computer.type_text({ app: "Fixture", text: "Příliš 🐈" });
        expect(calls[1]).toContain("Příliš 🐈");
        expect(calls[1]).toContain("2");
        await computer.press_key({ app: "Fixture", revision: typed.state!.revision, key: "super+a" });
        expect(calls[2]).toContain("cmd,a");
        await expect(
            computer.type_text({ app: "Fixture", revision: state.revision, text: "line\nsubmit" })
        ).rejects.toThrow("multiline");
        expect(calls).toHaveLength(3);
    });
    test("retains explicit chrome scope and rejects app replacement", async () => {
        const { computer, snapshot, calls } = fixture();
        await computer.get_app_state({ app: "Fixture", scope: "chrome", image: false });
        await computer.get_app_state({ app: "Fixture", image: false });
        expect(calls[1]).toContain("chrome");
        snapshot.processLaunch = 124;
        await expect(computer.get_app_state({ app: "Fixture", image: false })).rejects.toThrow("process changed");
        await expect(computer.click({ app: "Fixture", element_index: 1 })).rejects.toThrow("get_app_state");
    });
    test("close_session drops references without quitting the actual app", async () => {
        const { computer, calls } = fixture();
        await computer.get_app_state({ app: "Fixture", image: false });
        computer.close_session({ app: "Fixture" });
        await expect(computer.click({ app: "Fixture", element_index: 1 })).rejects.toThrow("get_app_state");
        expect(calls).toHaveLength(1);
        expect(await computer.list_apps()).toEqual([
            { id: "example.fixture", displayName: "Fixture", pid: 7, isRunning: true, frontmost: true, hidden: false },
        ]);
    });
});
test("native MCP advertises and dispatches its own tools; unknown names use protocol errors", async () => {
    const { computer, calls } = fixture();
    const server = createComputerMcpServer({ computer });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fixture-client", version: "1" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toContain("get_app_state");
        expect(listed.tools.map((tool) => tool.name)).toContain("paste");
        const state = await client.callTool({ name: "get_app_state", arguments: { app: "Fixture", image: false } });
        expect(state.isError).toBe(false);
        const acted = await client.callTool({ name: "click", arguments: { app: "Fixture", element_index: 1 } });
        expect(acted.isError).toBe(false);
        expect(calls).toHaveLength(2);
        await expect(client.callTool({ name: "unknown", arguments: {} })).rejects.toThrow("Unknown tool");
    } finally {
        await client.close();
        await server.close();
    }
});
test("Computer Use REPL bootstraps its own API and retains bindings across cells", async () => {
    const engine = new ComputerReplEngine();
    try {
        const first = await engine.run("const retained = computer; computer.target");
        expect(first.ok).toBe(true);
        expect(first.text).toBe("mac");
        const next = await engine.run("retained === computer");
        expect(next.ok).toBe(true);
        expect(next.text).toBe("true");
    } finally {
        engine.dispose();
    }
});

test("a thrown native transport invalidates all old refs without repeating the action", async () => {
    const f = fixture();
    const original = f.native.run;
    let attempts = 0;
    f.native.run = async (call) => {
        if (call.args[0] === "act") {
            attempts++;
            throw new Error("Lost delivery");
        }
        return original(call);
    };
    const state = await f.computer.get_app_state({ app: "Fixture", image: false });
    const result = await f.computer.click({ app: "Fixture", element_ref: state.elements[1].ref });
    expect(result.ok).toBe(false);
    expect(result.action.effect).toBe("unknown");
    await expect(f.computer.click({ app: "Fixture", element_ref: state.elements[1].ref })).rejects.toThrow(
        "get_app_state"
    );
    expect(attempts).toBe(1);
});

test("Computer Use exposes exact choices and readbacks without enabling Jev implicitly", async () => {
    const { computer, calls } = fixture();
    await computer.get_app_state({ app: "Fixture", image: false });
    const choice = await computer.resolve_target({ app: "Fixture", intent: "Save" });
    expect(choice.source).toBe("exact");
    expect(choice.ref).not.toBeNull();
    expect(choice.metrics.requests).toBe(0);
    await expect(computer.verify_state({ app: "Fixture", expect: "Saved" })).rejects.toThrow("explicitly enable Jev");
    expect(calls).toHaveLength(1);
    const readback = await computer.verify_state({
        app: "Fixture",
        expect: "Original value",
        exact: { identifier: "name", value: "old" },
    });
    expect(readback.status).toBe("verified");
    expect(readback.metrics.requests).toBe(0);
    expect(calls).toHaveLength(2);
});
