import { describe, expect, test } from "bun:test";
import {
    buildTeammateClaudeArgs,
    buildToolsCcTeammateCommand,
    isLiveSidechain,
    LIVE_SIDECHAIN_MS,
    launchTeammate,
} from "./launch";
import type { TeamMemberView, TeamView } from "./types";

/** Runs `fn` with Bun.spawnSync recorded, so a test can prove nothing spawned. */
async function withSpawnSpy(fn: () => Promise<unknown>): Promise<{ result: unknown; calls: string[][] }> {
    const original = Bun.spawnSync;
    const calls: string[][] = [];
    // A spawn here would be the regression: a second process for a teammate
    // that is already running inside the lead. Throwing makes it loud.
    (Bun as { spawnSync: unknown }).spawnSync = (cmd: string[]) => {
        calls.push(cmd);
        throw new Error(`unexpected spawn: ${cmd.join(" ")}`);
    };

    try {
        return { result: await fn(), calls };
    } finally {
        (Bun as { spawnSync: unknown }).spawnSync = original;
    }
}

function liveSidechain(): TeamMemberView["transcript"] {
    return {
        sessionId: "55a1a95d-4c46-4f3d-8a2d-5b27191ed430",
        path: "/tmp/55a1a95d/subagents/agent-a1.jsonl",
        mtimeMs: Date.now() - 2_000,
        hasLeadAssignment: true,
        messageCount: 4,
        sidechain: true,
    };
}

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

    test("false once the sidechain has gone quiet past the age boundary", () => {
        // The boundary gates whether launchTeammate spawns a second process,
        // so both sides of it are pinned. `now` is injectable — no real clock.
        const base = { sessionId: "abc", path: "/tmp/x.jsonl", hasLeadAssignment: true, messageCount: 1 };
        const now = 1_000_000_000_000;

        expect(isLiveSidechain({ ...base, mtimeMs: now - (LIVE_SIDECHAIN_MS - 1), sidechain: true }, now)).toBe(true);
        expect(isLiveSidechain({ ...base, mtimeMs: now - LIVE_SIDECHAIN_MS, sidechain: true }, now)).toBe(false);
        expect(isLiveSidechain({ ...base, mtimeMs: now - LIVE_SIDECHAIN_MS * 3, sidechain: true }, now)).toBe(false);
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
        const cmd = buildToolsCcTeammateCommand("martin", fakeTeam(), fakeMate());
        expect(cmd).toContain("tools cc run 'martin' --");
        expect(cmd).toContain("--agent-name");
        expect(cmd).toContain("bm-research-product");
        expect(cmd).toContain("cd '/Users/Martin/Tresors/Projects/GenesisPlayground'");
    });
});

describe("launchTeammate with a live in-process teammate", () => {
    test("attach does not spawn a second process", async () => {
        const { result, calls } = await withSpawnSpy(() =>
            launchTeammate({
                team: fakeTeam(),
                teammate: fakeMate({ transcript: liveSidechain() }),
                account: "martin",
                mode: "attach",
            })
        );

        expect((result as { action: string }).action).toBe("noop");
        expect((result as { detail: string }).detail).toContain("still live");
        expect(calls).toHaveLength(0);
    });

    test("focus without a resolvable lead pane hands over the lead session instead of spawning", async () => {
        // Discovery cannot name the lead pane for a team whose teammates are
        // all in-process, so this is the common path, not a corner case.
        const transcript = liveSidechain();
        const { result, calls } = await withSpawnSpy(() =>
            launchTeammate({
                team: fakeTeam({ lead: undefined }),
                teammate: fakeMate({ transcript }),
                account: "martin",
                mode: "focus",
            })
        );

        expect((result as { action: string }).action).toBe("noop");
        // The WHOLE session id: a truncated one still matches a prefix but
        // produces a focus command that cannot resolve anything.
        expect((result as { detail: string }).detail).toContain(`tools claude cmux focus ${transcript?.sessionId}`);
        expect(calls).toHaveLength(0);
    });
});
