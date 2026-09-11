import { describe, expect, test } from "bun:test";
import type { AgentSession, AgentSessionAdapter } from "@genesiscz/utils/agent-sessions/types";
import { env } from "@genesiscz/utils/env";
import { buildGrokTuiSpawn, grokTuiResumeArgv, resolveGrokTuiSession } from "./tui-resume";

const SESSION = {
    sessionId: "sess_0001",
    title: "resume me",
    cwd: "/tmp/grok-tui-resume",
} as AgentSession;

describe("buildGrokTuiSpawn", () => {
    test("resumes the picked session in its own cwd", () => {
        const spawn = buildGrokTuiSpawn({ session: SESSION, binary: "/fixture/grok" });

        expect(spawn.cmd.slice(1)).toEqual(["-r", "sess_0001"]);
        expect(spawn.cmd[0]).toBe("/fixture/grok");
        expect(spawn.cwd).toBe("/tmp/grok-tui-resume");
    });

    /**
     * Grok names a login by its home, never by an account, and no transcript records one
     * either. This export is the only thing that lets a live grok pane be attributed to an
     * account off the process table, the way `tools claude run` panes already are.
     */
    test("the account rides in TOOLS_GROK_ACCOUNT, and is absent when none was resolved", () => {
        expect(
            buildGrokTuiSpawn({ session: SESSION, binary: "/fixture/grok", account: "personal" }).env.TOOLS_GROK_ACCOUNT
        ).toBe("personal");
        expect(buildGrokTuiSpawn({ session: SESSION, binary: "/fixture/grok" }).env.TOOLS_GROK_ACCOUNT).toBeUndefined();
    });

    test("the child env comes from the env facade, so a test override reaches it", async () => {
        await env.testing.withOverrides({ GROK_TUI_RESUME_PROBE: "on" }, () => {
            expect(buildGrokTuiSpawn({ session: SESSION, binary: "/fixture/grok" }).env.GROK_TUI_RESUME_PROBE).toBe(
                "on"
            );
        });

        expect(
            buildGrokTuiSpawn({ session: SESSION, binary: "/fixture/grok" }).env.GROK_TUI_RESUME_PROBE
        ).toBeUndefined();
    });
});

function session(id: string, title: string): AgentSession {
    return {
        kind: "grok",
        sessionId: id,
        cwd: "/Users/me/Projects/shop",
        title,
        mtime: new Date("2026-09-03T10:00:00.000Z"),
        filePath: `/tmp/${id}.json`,
    };
}

const A = session("01a05cc5-0ecf-7d40-945e-977e45b3f935", "PRs merged into release/2026-09-03");
const B = session("01a05d17-c512-7dd2-abb6-e62d8c7d612a", "aws-costs");

function adapterWithSearch(hits: AgentSession[]): AgentSessionAdapter {
    return {
        kind: "grok",
        async list() {
            return [A, B];
        },
        async search() {
            return hits;
        },
    };
}

describe("parseResumeLimit", () => {
    test("defaults and rejects non-integers", async () => {
        const { parseResumeLimit } = await import("./tui-resume");
        expect(parseResumeLimit(undefined)).toBe(20);
        expect(parseResumeLimit("5")).toBe(5);
        expect(() => parseResumeLimit("nope")).toThrow(/positive integer/);
        expect(() => parseResumeLimit("20.5")).toThrow(/positive integer/);
    });
});

describe("grokTuiResumeArgv", () => {
    test("pins -r through resumeArgv", () => {
        expect(grokTuiResumeArgv("/usr/bin/grok", A.sessionId)).toEqual(["/usr/bin/grok", "-r", A.sessionId]);
    });
});

describe("resolveGrokTuiSession", () => {
    test("a unique body-search hit resumes that session", async () => {
        const session = await resolveGrokTuiSession({ query: "burn auth" }, adapterWithSearch([A]));
        expect(session?.sessionId).toBe(A.sessionId);
    });

    test("an empty body search does not fall back to the unfiltered list", async () => {
        process.exitCode = 0;
        const session = await resolveGrokTuiSession({ query: "no-such-body" }, adapterWithSearch([]));
        expect(session).toBeUndefined();
        expect(process.exitCode).toBe(1);
        process.exitCode = 0;
    });
});

test("bare resume delegates selection to native Grok instead of a wrapper picker", () => {
    const spawn = buildGrokTuiSpawn({ binary: "/fixture/grok" });
    expect(spawn.cmd.slice(1)).toEqual(["--resume"]);
    expect(spawn.cwd).toBe(process.cwd());
});

test("query resume opens the selected session's native home without changing the parent environment", async () => {
    await env.testing.withOverrides({ GROK_HOME: "/personal-home" }, () => {
        const launch = buildGrokTuiSpawn({
            session: { ...SESSION, sourceHome: "/worker-home" },
            binary: "/fixture/grok",
        });
        expect(launch.env.GROK_HOME).toBe("/worker-home");
        expect(env.getProcessEnv().GROK_HOME).toBe("/personal-home");
        expect(buildGrokTuiSpawn({ binary: "/fixture/grok" }).env.GROK_HOME).toBe("/personal-home");
    });
});
