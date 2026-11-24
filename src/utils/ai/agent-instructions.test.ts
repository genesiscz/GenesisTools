import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import {
    AGENT_STOP_LINE,
    type AgentInstructions,
    AgentInstructionsError,
    agentInstructionsResult,
    formatAgentInstructions,
    outputAgentInstructions,
} from "./agent-instructions";

const stop: AgentInstructions = {
    text: "A confirmation window asks the user now.\nRun the same command again after the user confirms.",
    severity: "info",
    stop: true,
};
const note: AgentInstructions = { text: "  The question stays open for the user.  ", severity: "error", stop: false };

describe("agent instructions", () => {
    afterEach(() => {
        process.exitCode = 0;
    });

    test("a stop opens with FOR AGENTS: STOP and ends on the line that says to ask the user", () => {
        const lines = formatAgentInstructions(stop).split("\n");

        expect(lines[0]).toBe("==== FOR AGENTS: STOP (info) ====");
        expect(lines.slice(1, 3)).toEqual(stop.text.split("\n"));
        expect(lines.at(-1)).toBe(AGENT_STOP_LINE);
    });

    test("an instruction that does not stop keeps its severity and ends on its own last line", () => {
        expect(formatAgentInstructions(note)).toBe(
            "==== FOR AGENTS (error) ====\nThe question stays open for the user."
        );
    });

    test("the JSON form carries the same severity, stop and body as the block", () => {
        expect(agentInstructionsResult(stop)).toEqual({
            agentInstructions: { severity: "info", stop: true, text: `${stop.text}\n${AGENT_STOP_LINE}` },
        });
        expect(agentInstructionsResult(note).agentInstructions.text).toBe("The question stays open for the user.");
    });

    test("output goes to stdout through out: the block, or the JSON result, and no exit code", () => {
        const println = spyOn(out, "println").mockImplementation(() => undefined);
        const result = spyOn(out, "result").mockImplementation(() => undefined);
        try {
            outputAgentInstructions(stop);
            outputAgentInstructions(stop, { json: true });

            expect(println.mock.calls).toEqual([[formatAgentInstructions(stop)]]);
            expect(result.mock.calls).toEqual([[SafeJSON.stringify(agentInstructionsResult(stop))]]);
            expect(process.exitCode).toBe(0);
        } finally {
            println.mockRestore();
            result.mockRestore();
        }
    });

    test("a thrown instruction carries the block as its message and the instruction itself", () => {
        const error = new AgentInstructionsError(note);

        expect(error.message).toBe(formatAgentInstructions(note));
        expect(error.instructions).toEqual(note);
        expect(error).toBeInstanceOf(Error);
    });
});
