import { describe, expect, it } from "bun:test";
import {
    routedToolName,
    stripRoutingTag,
    TOOL_ROUTING_TAG,
    tagAmbiguousNoArgTools,
} from "@app/ai-proxy/lib/translators/formats/anthropic/tool-routing-tag";

const noArg = (name: string) => ({
    name,
    description: "x",
    input_schema: { type: "object", properties: {}, required: [] },
});

describe("tagAmbiguousNoArgTools", () => {
    it("tags each no-arg tool with an enum of its own name", () => {
        const body = { tools: [noArg("ListAgents"), noArg("TaskList")] };
        const tagged = tagAmbiguousNoArgTools(body);

        expect(tagged).toEqual(new Set(["ListAgents", "TaskList"]));

        for (const name of ["ListAgents", "TaskList"]) {
            const tool = body.tools.find((t) => t.name === name);
            const schema = tool?.input_schema as Record<string, unknown>;
            expect(schema.required).toEqual([TOOL_ROUTING_TAG]);
            expect((schema.properties as Record<string, unknown>)[TOOL_ROUTING_TAG]).toEqual({
                type: "string",
                enum: [name],
                description: `Routing tag required by this endpoint. Always exactly "${name}".`,
            });
        }
    });

    it("does nothing when there is no ambiguity to resolve", () => {
        // One no-arg tool is already unique against every argument-taking tool,
        // so its schema must reach the model exactly as the client wrote it.
        const single = {
            tools: [
                noArg("ListAgents"),
                { name: "Bash", input_schema: { type: "object", properties: { c: {} }, required: ["c"] } },
            ],
        };
        expect(tagAmbiguousNoArgTools(single)).toEqual(new Set());
        expect((single.tools[0].input_schema as Record<string, unknown>).required).toEqual([]);

        expect(tagAmbiguousNoArgTools({})).toEqual(new Set());
        expect(tagAmbiguousNoArgTools({ tools: [] })).toEqual(new Set());
    });

    it("keeps the tool's own optional properties callable alongside the tag", () => {
        const body = {
            tools: [
                {
                    name: "ListAgents",
                    input_schema: { type: "object", properties: { channel: { type: "string" } }, required: [] },
                },
                noArg("TaskList"),
            ],
        };
        tagAmbiguousNoArgTools(body);

        const schema = body.tools[0].input_schema as Record<string, unknown>;
        expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(["channel", TOOL_ROUTING_TAG]);
    });
});

describe("routedToolName", () => {
    it("trusts the tag only when it names a tool this request tagged", () => {
        const tagged = new Set(["ListAgents"]);

        expect(routedToolName({ [TOOL_ROUTING_TAG]: "ListAgents" }, tagged)).toBe("ListAgents");

        // A tool that was never tagged cannot be reached through the tag, so a
        // coincidental property of the same name cannot redirect a call.
        expect(routedToolName({ [TOOL_ROUTING_TAG]: "Bash" }, tagged)).toBeUndefined();
        expect(routedToolName({ [TOOL_ROUTING_TAG]: 7 }, tagged)).toBeUndefined();
        expect(routedToolName({}, tagged)).toBeUndefined();
    });
});

describe("stripRoutingTag", () => {
    it("removes the proxy's own property and leaves everything else alone", () => {
        expect(stripRoutingTag(`{"${TOOL_ROUTING_TAG}":"ListAgents"}`)).toBe("{}");
        expect(stripRoutingTag(`{"${TOOL_ROUTING_TAG}":"ListAgents","channel":"ops"}`)).toBe('{"channel":"ops"}');
        expect(stripRoutingTag('{"command":"date"}')).toBe('{"command":"date"}');
    });

    it("returns unparseable text untouched so a bad call still fails on its own terms", () => {
        expect(stripRoutingTag('{"command":')).toBe('{"command":');
        expect(stripRoutingTag("")).toBe("");
    });
});
