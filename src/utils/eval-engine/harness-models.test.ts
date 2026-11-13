// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/harness-models.test.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    buildJudgeRequest,
    buildSimulatorRequest,
    JudgePromptVersion,
    parseJudgeAnswer,
    readSimulatorText,
    SimulatorStopWord,
} from "./harness-models";

describe("the judge", () => {
    it("reads one line of JSON, also inside other text, and refuses anything else", () => {
        assert.deepEqual(parseJudgeAnswer('{"answer":"yes","reason":"it asks once"}'), {
            result: "pass",
            reason: "it asks once",
        });
        assert.deepEqual(parseJudgeAnswer('Sure. {"answer":"cannot-tell","reason":"no tool output"}'), {
            result: "inconclusive",
            reason: "no tool output",
        });
        assert.equal(parseJudgeAnswer('{"answer":"maybe","reason":""}'), null);
        assert.equal(parseJudgeAnswer("yes"), null);
    });

    it("shows the transcript with tool calls and names the turn", () => {
        const request = buildJudgeRequest(
            {
                key: "k",
                question: "Does it ask when?",
                scope: {
                    kind: "turn",
                    turn: 1,
                    toolCalls: [],
                    toolEvidence: "observed",
                    replies: ["Kdy?"],
                    signals: {},
                    transcript: [
                        { role: "user", text: "Bolí mě zub.", toolCalls: [] },
                        {
                            role: "assistant",
                            text: "Kdy?",
                            toolCalls: [{ name: "find_free_slots", input: { day: 1 }, output: [] }],
                        },
                    ],
                },
            },
            "judge-model"
        );
        assert.equal(request.purpose, "judge");
        assert.equal(request.model, "judge-model");
        assert.match(request.messages[0].content, /\[tool call\] find_free_slots \{"day":1\} -> \[\]/);
        assert.match(request.messages[0].content, /LAST reply \(turn 1\)/);
    });
});

describe("the simulated user", () => {
    it("swaps the roles and starts with a user message", () => {
        const request = buildSimulatorRequest(
            { persona: "You are a patient.", goal: "Book.", maxTurns: 3 },
            [
                { role: "user", text: "Hi", toolCalls: [] },
                { role: "assistant", text: "Hello, when?", toolCalls: [] },
            ],
            "sim"
        );
        assert.deepEqual(
            request.messages.map((m) => m.role),
            ["user", "assistant", "user"]
        );
        assert.match(request.system, /###STOP###/);
    });

    it("stops on the stop word or an empty text", () => {
        assert.deepEqual(readSimulatorText(`  ${SimulatorStopWord} `), { stop: true });
        assert.deepEqual(readSimulatorText(""), { stop: true });
        assert.deepEqual(readSimulatorText(" Monday? "), { stop: false, text: "Monday?" });
    });
});

it("tells the judge when tool evidence is unavailable", () => {
    const request = buildJudgeRequest(
        {
            key: "k",
            question: "Did a tool run?",
            scope: {
                kind: "turn",
                turn: 1,
                toolCalls: [],
                toolEvidence: "unavailable",
                replies: [],
                signals: {},
                transcript: [],
            },
        },
        "judge"
    );
    assert.match(request.system, /Missing tool calls do not prove/);
    assert.equal(JudgePromptVersion, 2);
});
