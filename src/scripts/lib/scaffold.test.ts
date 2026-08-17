import { describe, expect, it } from "bun:test";
import { bindNames, renderScriptModule, renderToolsModule } from "./scaffold.ts";

const takeScreenshot = {
    name: "take_screenshot",
    description: "Grab a screenshot",
    inputSchema: { type: "object", properties: { fullPage: { type: "boolean" } } },
};
const handoffPost = {
    name: "handoff_post",
    description: "File a handoff",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
};
const noArgs = { name: "list_pages", inputSchema: { type: "object", properties: {} } };

describe("bindNames", () => {
    it("bare camelCase names for a single server", () => {
        const bound = bindNames([
            { server: "chrome-devtools-mcp", tool: takeScreenshot },
            { server: "chrome-devtools-mcp", tool: noArgs },
        ]);
        expect(bound.map((b) => b.fnName)).toEqual(["takeScreenshot", "listPages"]);
    });

    it("server-prefixed names across servers, with collision suffixes", () => {
        const bound = bindNames([
            { server: "chrome-devtools-mcp", tool: takeScreenshot },
            { server: "genesis-tools", tool: handoffPost },
        ]);
        expect(bound.map((b) => b.fnName)).toEqual(["chromeDevtoolsMcp_takeScreenshot", "genesisTools_handoffPost"]);

        const collided = bindNames([
            { server: "a", tool: { name: "x" } },
            { server: "b", tool: { name: "x" } },
        ]);
        expect(collided.map((b) => b.fnName)).toEqual(["a_x", "b_x"]);
    });

    it("reserved and strict-mode-restricted words get a Tool suffix so the generated module parses", () => {
        const bound = bindNames([
            { server: "s", tool: { name: "delete" } },
            { server: "s", tool: { name: "new" } },
            { server: "s", tool: { name: "eval" } },
            { server: "s", tool: { name: "arguments" } },
            { server: "s", tool: { name: "list_pages" } },
        ]);
        expect(bound.map((b) => b.fnName)).toEqual(["deleteTool", "newTool", "evalTool", "argumentsTool", "listPages"]);
    });
});

describe("renderToolsModule", () => {
    it("emits alias import, arg types, optionality and the TOOLS map", () => {
        const bound = bindNames([
            { server: "chrome-devtools-mcp", tool: takeScreenshot },
            { server: "chrome-devtools-mcp", tool: handoffPost },
            { server: "chrome-devtools-mcp", tool: noArgs },
        ]);
        const module = renderToolsModule(bound, ["chrome-devtools-mcp.*"], "2026-08-17T00:00:00.000Z");

        expect(module).toContain('import type { Kit } from "@gt/scripts/kit";');
        expect(module).toContain("export type TakeScreenshotArgs = {");
        // All-optional args → optional parameter; required args → mandatory.
        expect(module).toContain("takeScreenshot = (kit: Kit, args?: TakeScreenshotArgs)");
        expect(module).toContain("handoffPost = (kit: Kit, args: HandoffPostArgs)");
        // No-arg tool gets no args parameter at all.
        expect(module).toContain("listPages = (kit: Kit) =>");
        expect(module).toContain(
            'kit.call("chrome-devtools-mcp", "take_screenshot", args as Record<string, unknown>);'
        );
        expect(module).toMatch(
            /export const TOOLS = \{\n {4}takeScreenshot,\n {4}handoffPost,\n {4}listPages,\n\} as const;/
        );
    });

    it("control characters in names are escaped into valid string literals", () => {
        const bound = bindNames([{ server: "s", tool: { name: "weird\nname" } }]);
        const module = renderToolsModule(bound, ["s.*"], "2026-08-17T00:00:00.000Z");

        expect(module).toContain('"weird\\nname"');
        expect(module).not.toContain('weird\nname"');
    });
});

describe("renderScriptModule", () => {
    const base = {
        name: "demo",
        servers: ["chrome-devtools-mcp"],
        selectors: ["chrome-devtools-mcp.*"],
        createdFrom: "/somewhere",
        tags: [],
    };

    it("starts from a runnable no-required-args tool when one exists", () => {
        const bound = bindNames([{ server: "chrome-devtools-mcp", tool: takeScreenshot }]);
        const script = renderScriptModule({ ...base, bound });

        expect(script).toContain('import { text, withKit } from "@gt/scripts/kit";');
        expect(script).toContain('import * as T from "./demo.tools.ts";');
        expect(script).toContain("const result = await T.takeScreenshot(kit, {});");
        expect(script).toContain("tools scripts run demo");
    });

    it("comments the call out when every tool needs arguments", () => {
        const bound = bindNames([{ server: "genesis-tools", tool: handoffPost }]);
        const script = renderScriptModule({ ...base, servers: ["genesis-tools"], bound });

        expect(script).toContain("// Every bound tool needs arguments. handoffPost expects:");
        expect(script).toContain("// const result = await T.handoffPost(kit, { /* ... */ });");
    });

    it("renders a bindings-free scaffold when nothing was imported", () => {
        const script = renderScriptModule({ ...base, servers: [], selectors: [], bound: [] });

        expect(script).not.toContain("demo.tools.ts");
        expect(script).toContain("kit.callRef");
        expect(script).toContain("console.log(kit.servers());");
        expect(script).toContain("await withKit(async (kit) => {");
        expect(script).toMatch(/\}\);\n$/);
    });
});
