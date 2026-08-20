import { describe, expect, test } from "bun:test";
import { buildTeammateClaudeArgs, buildToolsCcTeammateCommand, isLiveSidechain } from "./launch";
import type { TeamMemberView, TeamView } from "./types";

function fakeTeam(over: Partial<TeamView> = {}): TeamView {
    return {
        teamName: "session-55a1a95d",
        configPath: "/tmp/config.json",
        config: {
            name: "session-55a1a95d",
            leadSessionId: "55a1a95d-4c46-4f3d-8a2d-5b27191ed430",
            members: [],
        },
        leadSessionId: "55a1a95d-4c46-4f3d-8a2d-5b27191ed430",
        cwd: "/Users/Martin/Tresors/Projects/GenesisPlayground",
        mtimeMs: Date.now(),
        members: [],
        teammates: [],
        ...over,
    };
}

function fakeMate(over: Partial<TeamMemberView> = {}): TeamMemberView {
    return {
        member: {
            agentId: "bm-research-product@session-55a1a95d",
            name: "bm-research-product",
            model: "sonnet",
            color: "blue",
            agentType: "general-purpose",
            cwd: "/Users/Martin/Tresors/Projects/GenesisPlayground",
            prompt: "Research BridgeMind thoroughly.",
        },
        isLead: false,
        backend: "tmux",
        status: "dead",
        activity: "stopped",
        ...over,
    };
}

describe("buildTeammateClaudeArgs", () => {
    test("includes agent-team identity flags", () => {
        const args = buildTeammateClaudeArgs(fakeTeam(), fakeMate());
        expect(args).toContain("--agent-id");
        expect(args).toContain("bm-research-product@session-55a1a95d");
        expect(args).toContain("--team-name");
        expect(args).toContain("session-55a1a95d");
        expect(args).toContain("--parent-session-id");
        expect(args).toContain("55a1a95d-4c46-4f3d-8a2d-5b27191ed430");
        expect(args).toContain("--model");
        expect(args).toContain("sonnet");
        expect(args).not.toContain("--resume");
    });

    test("adds --resume when transcript has lead assignment", () => {
        const args = buildTeammateClaudeArgs(
            fakeTeam(),
            fakeMate({
                transcript: {
                    sessionId: "bad27373-df6b-4e1f-a716-1fcda43f5f01",
                    path: "/tmp/x.jsonl",
                    mtimeMs: Date.now(),
                    hasLeadAssignment: true,
                    messageCount: 2,
                },
            })
        );
        expect(args).toContain("--resume");
        expect(args).toContain("bad27373-df6b-4e1f-a716-1fcda43f5f01");
        expect(args).toContain("--agent-id");
    });

    test("a sidechain resumes the lead session and does not pass --agent-id", () => {
        const leadId = "3ef3c468-e0f1-4959-8f16-e2d3ce7c4feb";
        const args = buildTeammateClaudeArgs(
            fakeTeam(),
            fakeMate({
                transcript: {
                    sessionId: leadId,
                    path: `/tmp/${leadId}/subagents/agent-apageobjects-fable-629d28c8906398e7.jsonl`,
                    mtimeMs: Date.now(),
                    hasLeadAssignment: true,
                    messageCount: 40,
                    sidechain: true,
                },
            })
        );
        expect(args).toEqual(["--resume", leadId]);
        expect(args).not.toContain("--agent-id");
    });
});

describe("isLiveSidechain", () => {
    test("true when the sidechain jsonl was written in the last 90s", () => {
        expect(
            isLiveSidechain({
                sessionId: "abc",
                path: "/tmp/x.jsonl",
                mtimeMs: Date.now() - 5_000,
                hasLeadAssignment: true,
                messageCount: 1,
                sidechain: true,
            })
        ).toBe(true);
    });

    test("false for a standalone transcript even if it is fresh", () => {
        expect(
            isLiveSidechain({
                sessionId: "abc",
                path: "/tmp/x.jsonl",
                mtimeMs: Date.now(),
                hasLeadAssignment: true,
                messageCount: 1,
            })
        ).toBe(false);
    });
});

describe("buildToolsCcTeammateCommand", () => {
    test("wraps tools cc run with account and flags", () => {
        const cmd = buildToolsCcTeammateCommand("foltyn", fakeTeam(), fakeMate());
        expect(cmd).toContain("tools cc run 'foltyn' --");
        expect(cmd).toContain("--agent-name");
        expect(cmd).toContain("bm-research-product");
        expect(cmd).toContain("cd '/Users/Martin/Tresors/Projects/GenesisPlayground'");
    });
});
