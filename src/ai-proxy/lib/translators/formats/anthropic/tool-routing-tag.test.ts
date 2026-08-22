import { describe, expect, it } from "bun:test";
import {
    routedToolName,
    stripRoutingTag,
    TOOL_ROUTING_TAG,
    tagConfusableTools,
} from "@app/ai-proxy/lib/translators/formats/anthropic/tool-routing-tag";

const noArg = (name: string) => ({
    name,
    description: "x",
    input_schema: { type: "object", properties: {}, required: [] },
});

describe("tagConfusableTools", () => {
    it("tags each no-arg tool with an enum of its own name", () => {
        const body = { tools: [noArg("ListAgents"), noArg("TaskList")] };
        const tagged = tagConfusableTools(body);

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

    it("tags overlapping arg-taking schemas: Glob and Grep both fit {pattern}", () => {
        // The live pair from Claude Code's toolset: required ∪ required =
        // {pattern} ⊆ properties ∩ properties = {pattern, path}, so a merged
        // `{"pattern":"*.ts"}` orphan fits either and only the tag can say
        // which call it was.
        const glob = {
            name: "Glob",
            input_schema: {
                type: "object",
                properties: { pattern: { type: "string" }, path: { type: "string" } },
                required: ["pattern"],
            },
        };
        const grep = {
            name: "Grep",
            input_schema: {
                type: "object",
                properties: { pattern: { type: "string" }, path: { type: "string" }, output_mode: { type: "string" } },
                required: ["pattern"],
            },
        };
        const bash = {
            name: "Bash",
            input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        };
        const body = { tools: [glob, grep, bash] };

        expect(tagConfusableTools(body)).toEqual(new Set(["Glob", "Grep"]));
        // Bash shares no property with either — untouched.
        expect((bash.input_schema as Record<string, unknown>).required).toEqual(["command"]);
        // The tag rides ALONGSIDE the real required key, not instead of it.
        expect((glob.input_schema as Record<string, unknown>).required).toEqual(["pattern", TOOL_ROUTING_TAG]);
    });

    it("does nothing when no pair of tools can share an argument object", () => {
        // One no-arg tool is already unique against every argument-taking tool,
        // so its schema must reach the model exactly as the client wrote it.
        const single = {
            tools: [
                noArg("ListAgents"),
                { name: "Bash", input_schema: { type: "object", properties: { c: {} }, required: ["c"] } },
            ],
        };
        expect(tagConfusableTools(single)).toEqual(new Set());
        expect((single.tools[0].input_schema as Record<string, unknown>).required).toEqual([]);

        // Distinct required keys with no shared properties: Edit's object can
        // never fit Write and vice versa.
        const distinct = {
            tools: [
                {
                    name: "Edit",
                    input_schema: {
                        type: "object",
                        properties: { file_path: {}, old_string: {}, new_string: {} },
                        required: ["file_path", "old_string", "new_string"],
                    },
                },
                {
                    name: "Write",
                    input_schema: {
                        type: "object",
                        properties: { file_path: {}, content: {} },
                        required: ["file_path", "content"],
                    },
                },
            ],
        };
        expect(tagConfusableTools(distinct)).toEqual(new Set());

        expect(tagConfusableTools({})).toEqual(new Set());
        expect(tagConfusableTools({ tools: [] })).toEqual(new Set());
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
        tagConfusableTools(body);

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
