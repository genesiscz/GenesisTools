import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { entryFromMcpTool, toolCallResult } from "@genesiscz/utils/mcp/tool-entry";
import type { ToolGroupRow } from "@genesiscz/utils/mcp/tool-group";
import { TOOL_GROUPS } from "./groups";
import { closeLoadedGroups, enabledToolGroups, filterRegistryByCapabilities, loadToolGroup } from "./server";

/**
 * The capability filter is a separation boundary, not a convenience: `question_ask` is the
 * blocking surface that interrupts the user, and `question_answer` only records history. A
 * config that enables one must never hand out the other.
 */

/** Only the names matter here, so the entries are the cheapest thing that satisfies the shape. */
function registry(
    ...names: string[]
): Record<string, { description: string; inputSchema: Record<string, unknown>; handler: () => Promise<string> }> {
    return Object.fromEntries(
        names.map((name) => [name, { description: name, inputSchema: {}, handler: async () => name }])
    );
}

const ALL = registry(
    "question_answer",
    "question_post",
    "question_wait",
    "question_poll",
    "question_respond",
    "question_cancel",

    "handoff_post",
    "question_update",
    "annotate_image",
    "jev_live",
    "question_tokens",
    "fetch_markdown",
    "fetch_jsonld",
    "alza_search_products",
    "waze_police"
);

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_MCP_CAPABILITIES");
});

function withCapabilities(value: string): string[] {
    env.testing.set("GENESIS_TOOLS_MCP_CAPABILITIES", value);

    return Object.keys(filterRegistryByCapabilities(ALL, env.tools.getMcpCapabilities())).sort();
}

describe("filterRegistryByCapabilities", () => {
    test("question_ask does NOT drag in question_answer", () => {
        // The old map used the prefix `question_`, which matches `question_answer` too, so
        // enabling only the blocking ask surface silently exposed the history-recording tool.
        const tools = withCapabilities("question_ask");

        expect(tools).toEqual([
            "question_cancel",
            "question_poll",
            "question_post",
            "question_respond",
            "question_tokens",
            "question_update",
            "question_wait",
        ]);
        expect(tools).not.toContain("question_answer");
    });

    test("question_answer does NOT drag in the blocking ask surface", () => {
        expect(withCapabilities("question_answer")).toEqual(["question_answer"]);
    });

    test("both together give both, and nothing else", () => {
        expect(withCapabilities("question_ask,question_answer")).toEqual([
            "question_answer",
            "question_cancel",
            "question_poll",
            "question_post",
            "question_respond",
            "question_tokens",
            "question_update",
            "question_wait",
        ]);
    });

    test("a prefix capability still matches its whole family", () => {
        expect(withCapabilities("handoff")).toEqual(["handoff_post"]);
        expect(withCapabilities("decision")).toEqual([
            "question_poll",
            "question_post",
            "question_tokens",
            "question_update",
        ]);
        expect(withCapabilities("annotate")).toEqual(["annotate_image"]);
        expect(withCapabilities("jev")).toEqual(["jev_live"]);
        expect(withCapabilities("fetch")).toEqual(["fetch_jsonld", "fetch_markdown"]);
        expect(withCapabilities("alza")).toEqual(["alza_search_products"]);
        expect(withCapabilities("waze")).toEqual(["waze_police"]);
    });

    test("an unset filter leaves every tool enabled", () => {
        env.testing.unset("GENESIS_TOOLS_MCP_CAPABILITIES");

        expect(Object.keys(filterRegistryByCapabilities(ALL, env.tools.getMcpCapabilities()))).toHaveLength(
            Object.keys(ALL).length
        );
    });

    test("an explicit undefined (an HTTP request with no header) ignores this process's env", () => {
        env.testing.set("GENESIS_TOOLS_MCP_CAPABILITIES", "handoff");

        expect(Object.keys(filterRegistryByCapabilities(ALL, undefined))).toHaveLength(Object.keys(ALL).length);
    });

    test("an unknown capability name enables nothing rather than everything", () => {
        expect(withCapabilities("does_not_exist")).toEqual([]);
    });

    // A config written while the boards tools existed must not start exposing everything now.
    test("the retired `boards` capability enables nothing", () => {
        expect(withCapabilities("boards")).toEqual([]);
    });
});

describe("the control capability", () => {
    test("control enables the control_* family and nothing else", () => {
        const withControl = registry(
            "question_answer",
            "control_run",
            "control_workflow_run",
            "control_find",
            "jev_live"
        );

        expect(Object.keys(filterRegistryByCapabilities(withControl, ["control"])).sort()).toEqual([
            "control_find",
            "control_run",
            "control_workflow_run",
        ]);
    });
});

describe("a standalone server's tool in the shared registry", () => {
    test("keeps the structured result the tool's own server sends, and an error result throws", async () => {
        const claims = { result: { claims: [{ id: "c1", detailAction: "claim_detail" }] } };
        const entry = entryFromMcpTool({
            description: "claims",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: false, destructiveHint: true },
            call: async () => ({ content: [{ type: "text", text: "1 claim" }], structuredContent: claims }),
        });
        expect(entry.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
        const answer = await entry.handler({});

        expect(answer).toEqual({ text: "1 claim", structuredContent: claims });
        expect(toolCallResult(answer)).toEqual({
            content: [{ type: "text", text: "1 claim" }],
            structuredContent: claims,
        });
        expect(toolCallResult("plain")).toEqual({ content: [{ type: "text", text: "plain" }] });

        const failing = entryFromMcpTool({
            description: "x",
            inputSchema: { type: "object" },
            call: async () => ({ isError: true, content: [{ type: "text", text: "Error: signed out" }] }),
        });
        await expect(failing.handler({})).rejects.toThrow("Error: signed out");
    });
});

describe("the usage capability", () => {
    test("usage enables the usage_* family and nothing else", () => {
        const withUsage = registry(
            "question_answer",
            "usage_limits",
            "usage_series",
            "usage_forecast",
            "usage_advise",
            "control_run"
        );

        expect(Object.keys(filterRegistryByCapabilities(withUsage, ["usage"])).sort()).toEqual([
            "usage_advise",
            "usage_forecast",
            "usage_limits",
            "usage_series",
        ]);
    });
});

describe("the tool group table", () => {
    test.each(TOOL_GROUPS.map((row) => [row.id, row] as const))("%s is reachable by its capability", (id, row) => {
        const names = registry(`${row.prefix}one`, `${row.prefix}two`, "question_answer", "handoff_post");

        expect(Object.keys(filterRegistryByCapabilities(names, [id])).sort()).toEqual([
            `${row.prefix}one`,
            `${row.prefix}two`,
        ]);
        expect(enabledToolGroups(TOOL_GROUPS, [id]).map((enabled) => enabled.id)).toEqual([id]);
    });

    test("an opt-in group is mounted only when the list names it, never for an unset list", () => {
        const optIn = TOOL_GROUPS.filter((row) => row.optIn).map((row) => row.id);
        const unset = enabledToolGroups(TOOL_GROUPS, undefined).map((row) => row.id);

        expect(optIn.sort()).toEqual(["alza", "waze"]);
        expect(unset.sort()).toEqual(["control", "fetch", "jev", "usage"]);
        expect(enabledToolGroups(TOOL_GROUPS, ["question_answer", "jev"]).map((row) => row.id)).toEqual(["jev"]);
    });

    test("a group loads once, and close calls every loaded group's close, even after one fails", async () => {
        const calls: string[] = [];
        const fake = (id: string, close?: () => Promise<void>): ToolGroupRow => ({
            id: `test_${id}`,
            prefix: `test_${id}_`,
            optIn: false,
            load: async () => {
                calls.push(`load ${id}`);
                return { entries: {}, close };
            },
        });
        const failing = fake("failing", async () => {
            calls.push("close failing");
            throw new Error("would not close");
        });
        const closing = fake("closing", async () => {
            calls.push("close closing");
        });
        const silent = fake("silent");

        await loadToolGroup(failing);
        await loadToolGroup(failing);
        await loadToolGroup(closing);
        await loadToolGroup(silent);
        await closeLoadedGroups();

        expect(calls).toEqual(["load failing", "load closing", "load silent", "close failing", "close closing"]);

        // A closed group is forgotten, so the next request loads it again.
        await loadToolGroup(closing);
        expect(calls.at(-1)).toBe("load closing");
        await closeLoadedGroups();
    });

    test("every group id has a line in the README capability list", async () => {
        const readme = await Bun.file(join(import.meta.dir, "..", "README.md")).text();

        for (const row of TOOL_GROUPS) {
            expect(readme).toMatch(new RegExp(`^- \`${row.id}\``, "m"));
        }
    });
});
