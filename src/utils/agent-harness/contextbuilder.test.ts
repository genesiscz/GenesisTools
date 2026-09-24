// Twins of harness/contextbuilder/{builder,control,submission}_test.go, in the same order and
// with the same names, so a reconcile can pair them file by file.

import { describe, expect, test } from "bun:test";
import { newBuilder, PREAMBLE, TOOL_CALL_RUNNING_PAYLOAD } from "./contextbuilder";
import type { Input } from "./inbox";
import type { Item, Reasoning, Tool, ToolCall, ToolResultOutput } from "./llm";

function withPreamble(...items: Item[]): Item[] {
    return [{ Type: "message", Data: { Role: "system", Text: PREAMBLE } }, ...items];
}

function text(value: string): ToolResultOutput[] {
    return [{ Kind: "text", Value: value }];
}

function toolResult(callID: string, output: ToolResultOutput[]): Item {
    return { Type: "tool_result", Data: { CallID: callID, Output: output } };
}

function external(id: string, payload: string): Input {
    return { ID: id, Kind: "external", Payload: payload };
}

describe("builder_test.go", () => {
    test("TestBuilderAddsExternalInputAsUserMessage", () => {
        const current = newBuilder();
        current.addExternalInput(external("input-1", '"Hello"'));

        expect(current.build().Request.Input).toEqual(
            withPreamble({ Type: "message", Data: { Role: "user", Text: "Hello" } })
        );
    });

    test("TestBuilderRejectsInvalidExternalInput", () => {
        const cases: Array<{ name: string; input: Input; want: string }> = [
            {
                name: "wrong kind",
                input: { ID: "input-1", Kind: "control" },
                want: 'external input "input-1" has input kind "control"',
            },
            { name: "invalid payload", input: external("input-1", "{"), want: 'decode external input "input-1"' },
        ];

        for (const { input, want } of cases) {
            const current = newBuilder();
            expect(() => current.addExternalInput(input)).toThrow(want);
            expect(current.build().Request.Input).toEqual(withPreamble());
        }
    });

    test("TestBuilderAddsModelResponseOutput", () => {
        const output: Item[] = [
            { ProviderID: "reasoning-1", Type: "reasoning", Data: { Summary: ["Need current weather."] } },
            { ProviderID: "message-1", Type: "message", Data: { Role: "assistant", Text: "Checking." } },
            {
                ProviderID: "call-item-1",
                Type: "tool_call",
                Data: { CallID: "call-1", Name: "weather", Arguments: '{"city":"London"}' },
            },
        ];
        const current = newBuilder();
        current.addModelResponse({
            ID: "response-1",
            Stop: "complete",
            Output: output,
            Usage: {
                InputTokens: 12,
                CachedInputTokens: 0,
                CacheWriteInputTokens: 0,
                OutputTokens: 8,
                ReasoningTokens: 0,
            },
        });

        expect(current.build().Request.Input).toEqual(withPreamble(...output));
    });

    test("TestBuilderBuildsRequestFromAddedValues", () => {
        const model = { ID: "gpt-test" };
        const weather: Tool = { Type: "function", Name: "weather", Description: "Get weather", Parameters: {} };
        const reasoning: Reasoning = { Summary: ["Need current weather."] };
        const call: ToolCall = { CallID: "call-1", Name: "weather", Arguments: '{"city":"London"}' };

        const current = newBuilder();
        current.setModel(model);
        current.addTool(weather);
        current.addReasoning(reasoning);
        current.commit();
        current.addModelResponse({
            ID: "",
            Stop: "complete",
            Output: [{ Type: "tool_call", Data: call }],
            Usage: usage(),
        });
        current.addToolResult("call-1", text("completed:operation-1"), false);

        expect(current.build()).toEqual({
            Request: {
                Model: model,
                Tools: [weather],
                Input: withPreamble(
                    { Type: "reasoning", Data: reasoning },
                    { Type: "tool_call", Data: call },
                    toolResult("call-1", text("completed:operation-1"))
                ),
            },
            Report: { Changes: [] },
        });
    });

    test("TestBuilderPreservesToolResultPayload", () => {
        const output: ToolResultOutput[] = [
            { Kind: "text", Value: `${"界".repeat(4_001)}�` },
            { Kind: "image", Value: "data:image/png;base64,aGVsbG8=" },
            { Kind: "text", Value: "Dimensions: 2000x1500" },
        ];
        const current = newBuilder();
        current.addToolResult("call-1", output, false);

        const result = current.build();
        expect(result.Request.Input[1]).toEqual(toolResult("call-1", output));
        expect(result.Report.Changes).toHaveLength(0);
    });

    test("TestBuilderAppendsValidationErrorToolResult", () => {
        const current = newBuilder();
        current.addToolResult("call-1", text("error:invalid arguments"), false);

        expect(current.build().Request.Input[1]).toEqual(toolResult("call-1", text("error:invalid arguments")));
    });

    test("TestBuilderRemovesOnlyStagedRunningResultsForUpdatedCall", () => {
        for (const running of [false, true]) {
            const output = running ? TOOL_CALL_RUNNING_PAYLOAD : "done A";
            const current = newBuilder();
            current.addToolResult("A", text(""), true);
            current.commit();
            current.addToolResult("A", text(""), true);
            current.addToolResult("B", text(""), true);
            current.addToolResult("C", text("done C"), false);
            current.addExternalInput(external("input", '"continue"'));
            const before = current.build();
            const original = [...before.Request.Input];
            current.addToolResult("A", text("done A"), running);

            expect(current.build().Request.Input).toEqual(
                withPreamble(
                    toolResult("A", text(TOOL_CALL_RUNNING_PAYLOAD)),
                    toolResult("B", text(TOOL_CALL_RUNNING_PAYLOAD)),
                    toolResult("C", text("done C")),
                    { Type: "message", Data: { Role: "user", Text: "continue" } },
                    toolResult("A", text(output))
                )
            );
            expect(before.Request.Input).toEqual(original);
        }
    });

    test("TestBuilderLeadsSystemPromptWithPreamble", () => {
        const current = newBuilder();
        current.setSystemPrompt("Be concise.");
        current.addExternalInput(external("input-1", '"hello"'));

        expect(current.build().Request.Input).toEqual([
            { Type: "message", Data: { Role: "system", Text: `${PREAMBLE}\n\nBe concise.` } },
            { Type: "message", Data: { Role: "user", Text: "hello" } },
        ]);
    });

    test("TestBuilderAppendsSkillsToPreamble", () => {
        const skills = [
            { Name: "go-review", Description: 'Review <Go> & "tests"', Path: "/skills/reviewer's/SKILL.md" },
            { Name: "documents", Description: "Edit documents", Path: "/skills/documents/SKILL.md" },
            // A YAML block-scalar description carries newlines; Go's encoding/xml escapes them as &#xA;.
            { Name: "multi", Description: "line one\nline\ttwo\r", Path: "/skills/multi/SKILL.md" },
        ];
        const current = newBuilder(...skills);
        skills[0].Name = "changed";
        current.setSystemPrompt("Be concise.");

        const want = `${PREAMBLE}

The following skills provide specialized instructions for specific tasks.
Use SkillUse to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool calls.

<available_skills><skill><name>go-review</name><description>Review &lt;Go&gt; &amp; &#34;tests&#34;</description><location>/skills/reviewer&#39;s/SKILL.md</location></skill><skill><name>documents</name><description>Edit documents</description><location>/skills/documents/SKILL.md</location></skill><skill><name>multi</name><description>line one&#xA;line&#x9;two&#xD;</description><location>/skills/multi/SKILL.md</location></skill></available_skills>

Be concise.`;
        expect(current.build().Request.Input[0]).toEqual({ Type: "message", Data: { Role: "system", Text: want } });
    });
});

function usage() {
    return { InputTokens: 0, CachedInputTokens: 0, CacheWriteInputTokens: 0, OutputTokens: 0, ReasoningTokens: 0 };
}

describe("control_test.go", () => {
    test("TestBuilderControlMessages", () => {
        const cases: Array<{ mode: "heartbeat" | "hard" | "when_idle"; text?: string }> = [
            { mode: "heartbeat", text: "requested" },
            { mode: "hard" },
            { mode: "when_idle" },
        ];

        for (const { mode, text: wantText } of cases) {
            const builder = newBuilder();
            builder.addControlMessage({ Mode: mode, Reason: "requested" });
            const input = builder.build().Request.Input.slice(1);

            if (!wantText) {
                expect(input).toHaveLength(0);
                continue;
            }

            expect(input).toEqual([{ Type: "message", Data: { Role: "user", Text: wantText } }]);
        }
    });

    test("TestBuilderSettingsOnlyChangeEffortInSubsequentRequests", () => {
        const builder = newBuilder();
        builder.setModel({ ID: "model", MaxOutputTokens: 123, ReasoningEffort: "high" });
        builder.addTool({ Type: "function", Name: "tool", Description: "", Parameters: {} });
        builder.addReasoning({ Summary: ["thought"] });
        const original = builder.build();
        builder.addControlMessage({ Mode: "settings", Reason: "", Parameters: { ReasoningEffort: "low" } });
        const built = builder.build();

        expect(built).toEqual({
            ...original,
            Request: { ...original.Request, Model: { ...original.Request.Model, ReasoningEffort: "low" } },
        });
        expect(original.Request.Model.ReasoningEffort).toBe("high");
    });
});

describe("submission_test.go", () => {
    test("TestBuilderPlacesResponseBeforeUnsubmittedInputs", () => {
        for (const emptyResponse of [false, true]) {
            const current = newBuilder();
            current.addExternalInput(external("first", '"start"'));
            current.commit();
            current.addModelResponse({
                ID: "",
                Stop: "complete",
                Usage: usage(),
                Output: [
                    { Type: "tool_call", Data: { CallID: "A", Name: "test", Arguments: "{}" } },
                    { Type: "tool_call", Data: { CallID: "B", Name: "test", Arguments: "{}" } },
                ],
            });
            current.addToolResult("A", text(""), true);
            current.addToolResult("B", text("done B"), false);
            const sent = current.build();
            const original = [...sent.Request.Input];
            current.commit();
            current.addToolResult("A", text(""), true);
            current.addToolResult("A", text("done A"), false);
            current.addExternalInput(external("second", '"continue"'));
            current.addControlMessage({ Mode: "heartbeat", Reason: "heartbeat" });
            current.addReasoning({ Summary: ["added reasoning"] });
            const preview = current.build();
            const suffix: Item[] = [
                toolResult("A", text("done A")),
                { Type: "message", Data: { Role: "user", Text: "continue" } },
                { Type: "message", Data: { Role: "user", Text: "heartbeat" } },
                { Type: "reasoning", Data: { Summary: ["added reasoning"] } },
            ];
            const wantPreview = [...original, ...suffix];
            expect(preview.Request.Input).toEqual(wantPreview);

            const output: Item[] = emptyResponse
                ? []
                : [
                      { ProviderID: "reasoning", Type: "reasoning", Data: { Summary: ["response reasoning"] } },
                      { ProviderID: "message", Type: "message", Data: { Role: "assistant", Text: "working" } },
                      { ProviderID: "call", Type: "tool_call", Data: { CallID: "C", Name: "test", Arguments: "{}" } },
                  ];
            current.addModelResponse({ ID: "", Stop: "complete", Usage: usage(), Output: output });
            const after = current.build();
            let want = [...original, ...output, ...suffix];
            expect(after.Request.Input).toEqual(want);
            expect(sent.Request.Input).toEqual(original);
            expect(preview.Request.Input).toEqual(wantPreview);

            current.commit();
            current.commit();
            current.addToolResult("C", text("done C"), false);
            const nextOutput: Item = { Type: "message", Data: { Role: "assistant", Text: "next response" } };
            current.addModelResponse({ ID: "", Stop: "complete", Usage: usage(), Output: [nextOutput] });
            const next = current.build();
            want = [...want, nextOutput, toolResult("C", text("done C"))];
            expect(next.Request.Input).toEqual(want);

            next.Request.Input[1] = { Type: "message", Data: { Role: "user", Text: "" } };
            expect(current.build().Request.Input).toEqual(want);
        }
    });

    test("TestBuilderSubmitsAlreadyCompletedResultsWithoutDelay", () => {
        const current = newBuilder();
        current.addToolResult("A", text(""), true);
        current.addToolResult("A", text("done A"), false);
        let want = withPreamble(toolResult("A", text("done A")));
        expect(current.build().Request.Input).toEqual(want);

        current.commit();
        const response: Item = { Type: "message", Data: { Role: "assistant", Text: "done" } };
        current.addModelResponse({ ID: "", Stop: "complete", Usage: usage(), Output: [response] });
        want = [...want, response];
        expect(current.build().Request.Input).toEqual(want);
    });

    test("TestBuilderUpdatesSystemPromptWithoutChangingConversation", () => {
        const current = newBuilder();
        current.setSystemPrompt("First instructions.");
        current.addExternalInput(external("input", '"start"'));
        current.commit();
        current.addToolResult("A", text("done A"), false);
        const before = current.build();

        for (const prompt of ["Updated instructions.", ""]) {
            current.setSystemPrompt(prompt);
            const after = current.build();
            const want = prompt ? `${PREAMBLE}\n\n${prompt}` : PREAMBLE;
            expect(after.Request.Input[0]).toEqual({ Type: "message", Data: { Role: "system", Text: want } });
            expect(after.Request.Input.slice(1)).toEqual(before.Request.Input.slice(1));
            expect(before.Request.Input[0]).toEqual({
                Type: "message",
                Data: { Role: "system", Text: `${PREAMBLE}\n\nFirst instructions.` },
            });
        }
    });
});
