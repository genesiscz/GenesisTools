import { describe, expect, test } from "bun:test";
import { buildAgentInstructions } from "./seed-instructions";

describe("buildAgentInstructions", () => {
    test("pins every agents command to the parent rendezvous session", () => {
        const instructions = buildAgentInstructions({
            agentName: "codex_reviewer",
            rendezvousSession: "parent-123",
            leadName: "lead",
        });

        expect(instructions).toContain("--from codex_reviewer --to lead");
        expect(instructions).toContain("--agent-name codex_reviewer --once --session parent-123");
        expect(instructions.match(/--session parent-123/g)?.length).toBeGreaterThanOrEqual(3);
    });
});
