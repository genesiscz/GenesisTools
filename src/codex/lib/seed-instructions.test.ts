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

    test("tells the worker it is the receiving end of a handoff", () => {
        const writable = buildAgentInstructions({
            agentName: "codex_implementer",
            rendezvousSession: "parent-123",
            leadName: "lead",
        });

        expect(writable).toContain("Your first action is to report in");
        expect(writable).toContain("Stop and report");
        expect(writable).toContain("never report a state you did not observe");

        const readOnly = buildAgentInstructions({
            agentName: "codex_reviewer",
            rendezvousSession: "parent-123",
            leadName: "lead",
            sandbox: "read-only",
        });

        expect(readOnly).toContain("Stop and report");
        expect(readOnly).not.toContain("tools agents message");
    });
});
