import { afterEach, describe, expect, test } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { filterRegistryByCapabilities } from "./server";

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
    "boards_read",
    "handoff_post",
    "question_update",
    "annotate_image",
    "jev_live"
);

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_MCP_CAPABILITIES");
});

function withCapabilities(value: string): string[] {
    env.testing.set("GENESIS_TOOLS_MCP_CAPABILITIES", value);

    return Object.keys(filterRegistryByCapabilities(ALL)).sort();
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
            "question_update",
            "question_wait",
        ]);
    });

    test("a prefix capability still matches its whole family", () => {
        expect(withCapabilities("boards")).toEqual(["boards_read"]);
        expect(withCapabilities("handoff")).toEqual(["handoff_post"]);
        expect(withCapabilities("decision")).toEqual(["question_poll", "question_post", "question_update"]);
        expect(withCapabilities("annotate")).toEqual(["annotate_image"]);
        expect(withCapabilities("jev")).toEqual(["jev_live"]);
    });

    test("an unset filter leaves every tool enabled", () => {
        env.testing.unset("GENESIS_TOOLS_MCP_CAPABILITIES");

        expect(Object.keys(filterRegistryByCapabilities(ALL))).toHaveLength(Object.keys(ALL).length);
    });

    test("an unknown capability name enables nothing rather than everything", () => {
        expect(withCapabilities("does_not_exist")).toEqual([]);
    });
});
