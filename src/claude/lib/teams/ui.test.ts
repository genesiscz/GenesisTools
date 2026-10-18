import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime, spyOn } from "bun:test";
import { out } from "@genesiscz/utils/logger";
import type { TableSelectOptions } from "@genesiscz/utils/prompts/clack/table-select";
import { stripAnsi } from "@genesiscz/utils/string";
import type { LaunchResult, LaunchTeammateOptions } from "./launch";
import type { LiveTeammateProcess, TeamMemberView, TeammateTranscriptRef, TeamView } from "./types";

interface State {
    interactive: boolean;
    teams: TeamView[];
    byName: Map<string, TeamView>;
    answers: unknown[];
    prompts: Array<TableSelectOptions<unknown>>;
    discoverCalls: Array<{ all?: boolean }>;
    env: Record<number, Record<string, string>>;
    launchCalls: LaunchTeammateOptions[];
    launchResult: LaunchResult;
    launchError: Error | null;
}

const state: State = {
    interactive: true,
    teams: [],
    byName: new Map(),
    answers: [],
    prompts: [],
    discoverCalls: [],
    env: {},
    launchCalls: [],
    launchResult: { action: "launched", detail: "Launched in a new window", command: "tools cc run work" },
    launchError: null,
};

const realCli = await import("@genesiscz/utils/cli");
const realTableSelect = await import("@genesiscz/utils/prompts/clack/table-select");
const realDiscover = await import("./discover");
const realLaunch = await import("./launch");
const realStatus = await import("./status");

mock.module("@genesiscz/utils/cli", () => ({ ...realCli, isInteractive: () => state.interactive }));
mock.module("@genesiscz/utils/prompts/clack/table-select", () => ({
    ...realTableSelect,
    tableSelect: async (options: TableSelectOptions<unknown>) => {
        state.prompts.push(options);
        return state.answers.length > 0 ? state.answers.shift() : null;
    },
}));
mock.module("./discover", () => ({
    ...realDiscover,
    discoverTeams: (options: { all?: boolean } = {}) => {
        state.discoverCalls.push(options);
        return state.teams;
    },
    discoverTeam: (name: string) => state.byName.get(name),
}));
mock.module("./launch", () => ({
    ...realLaunch,
    buildToolsCcTeammateCommand: (account: string, team: TeamView, mate: TeamMemberView) =>
        `tools cc run ${account} ${team.teamName} ${mate.member.name}`,
    pickDefaultAccount: async () => "default-acct",
    launchTeammate: async (options: LaunchTeammateOptions) => {
        state.launchCalls.push(options);

        if (state.launchError) {
            throw state.launchError;
        }

        return state.launchResult;
    },
}));
mock.module("./status", () => ({
    ...realStatus,
    readProcessEnvKeys: (pid: number) => state.env[pid] ?? {},
}));

const { printTeamsList, renderTeamsTree, runTeamsInteractive } = await import("./ui");

// A fixed clock: the age labels read Date.now() on every render, so a module-load timestamp would turn "30s"
// into "31s" whenever a second passes before the assertion.
const NOW = new Date("2026-10-18T12:00:00Z").getTime();

beforeEach(() => {
    setSystemTime(new Date(NOW));
});

afterEach(() => {
    setSystemTime();
});

function live(pid: number, extra: Partial<LiveTeammateProcess> = {}): LiveTeammateProcess {
    return { pid, cmdline: "claude --agent-id x", agentId: "x", agentName: "x", teamName: "t", ...extra };
}

function transcript(extra: Partial<TeammateTranscriptRef> = {}): TeammateTranscriptRef {
    return {
        sessionId: "abcdef1234567890",
        path: "/tmp/fixture/abcdef12.jsonl",
        mtimeMs: NOW - 3_600_000,
        hasLeadAssignment: true,
        messageCount: 12,
        ...extra,
    };
}

function mate(name: string, extra: Partial<TeamMemberView> = {}): TeamMemberView {
    return {
        member: { agentId: `${name}@team`, name },
        isLead: false,
        backend: "tmux",
        status: "dead",
        activity: "",
        ...extra,
    };
}

function team(name: string, teammates: TeamMemberView[] = [], extra: Partial<TeamView> = {}): TeamView {
    return {
        teamName: name,
        configPath: `/tmp/fixture/${name}/config.json`,
        config: { name, members: [] },
        mtimeMs: NOW - 5 * 60_000,
        members: teammates,
        teammates,
        ...extra,
    };
}

const printed: string[] = [];
let println: ReturnType<typeof spyOn<typeof out, "println">>;

beforeEach(() => {
    printed.length = 0;
    state.interactive = true;
    state.teams = [];
    state.byName = new Map();
    state.answers = [];
    state.prompts = [];
    state.discoverCalls = [];
    state.env = {};
    state.launchCalls = [];
    state.launchResult = { action: "launched", detail: "Launched in a new window", command: "tools cc run work" };
    state.launchError = null;
    println = spyOn(out, "println").mockImplementation((raw?: unknown) => {
        printed.push(raw === undefined ? "" : stripAnsi(String(raw)));
    });
});

afterEach(() => {
    println.mockRestore();
});

describe("renderTeamsTree", () => {
    it("says so when there are no teams", () => {
        expect(renderTeamsTree([]).map(stripAnsi)).toEqual(["(no agent teams found)"]);
    });

    it("draws a team with its lead and teammates as a tree", () => {
        const alice = mate("alice", {
            status: "running",
            member: { agentId: "alice@team", name: "alice", model: "opus" },
            activity: "editing invoice.ts",
            live: live(4242, { tmuxPaneId: "%3", account: "work" }),
        });
        const bob = mate("bob", { status: "idle" });
        const lead = mate("team-lead", { isLead: true, status: "running" });
        const view = team("session-abc", [alice, bob], {
            lead,
            leadSessionId: "fedcba9876543210",
            cwd: "/work/acme",
            tmuxSession: "main",
            mtimeMs: NOW - 2 * 3_600_000,
        });

        expect(renderTeamsTree([view]).map(stripAnsi)).toEqual([
            "session-abc  1 live  main  2h  /work/acme",
            "├─ ● run team-lead  fedcba98",
            "├─ ● run alice  opus  tmux",
            "│  ├─ editing invoice.ts",
            "│  └─ pid 4242  pane %3  acct work",
            "└─ ● idle bob  ?  tmux",
            "",
        ]);
    });

    it("labels the age of a team in seconds, minutes, hours and days", () => {
        const ages = [30_000, 5 * 60_000, 3 * 3_600_000, 2 * 86_400_000].map((ms, i) =>
            team(`t${i}`, [], { mtimeMs: NOW - ms })
        );
        const heads = renderTeamsTree(ages)
            .map(stripAnsi)
            .filter((line) => line.startsWith("t"));

        expect(heads.map((line) => line.trimEnd())).toEqual([
            "t0  none live  no-tmux  30s",
            "t1  none live  no-tmux  5m",
            "t2  none live  no-tmux  3h",
            "t3  none live  no-tmux  2d",
        ]);
    });

    it("shows a badge for every kind of teammate status", () => {
        const view = team("statuses", [
            mate("a", { status: "running" }),
            mate("b", { status: "not-logged-in" }),
            mate("c", { status: "dead" }),
            mate("d", { status: "idle" }),
            mate("e", { status: "unknown" }),
        ]);
        const lines = renderTeamsTree([view]).map(stripAnsi);

        expect(lines.slice(1, 6)).toEqual([
            "├─ ● run a  ?  tmux",
            "├─ ● auth b  ?  tmux",
            "├─ ○ dead c  ?  tmux",
            "├─ ● idle d  ?  tmux",
            "└─ · ? e  ?  tmux",
        ]);
    });

    it("cuts a long activity line to 96 characters", () => {
        const view = team("long", [mate("a", { activity: "x".repeat(120) })]);
        const lines = renderTeamsTree([view]).map(stripAnsi);

        expect(lines[2]).toBe(`   └─ ${"x".repeat(95)}…`);
    });

    it("warns when the lead assignment is missing from a teammate's transcript", () => {
        const view = team("warn", [
            mate("a", {
                member: { agentId: "a@team", name: "a", prompt: "Review the invoice module" },
                transcript: transcript({ hasLeadAssignment: false }),
            }),
        ]);

        expect(renderTeamsTree([view]).map(stripAnsi)[2]).toBe("   └─ missing lead assignment: attach injects it");
    });

    it("warns that attaching to an in-process teammate starts a new session", () => {
        const stale = mate("stale", { backend: "in-process" });
        const sidechain = mate("busy", {
            transcript: transcript({ sidechain: true, mtimeMs: Date.now() }),
        });
        const lines = renderTeamsTree([team("inproc", [stale, sidechain])]).map(stripAnsi);

        expect(lines).toContain(
            "│  └─ in-process: attach/split does not restore the last tool call (new session, or lead resume)"
        );
        expect(lines).toContain(
            "   └─ in-process still live: attach/split starts a new session and re-invokes the assignment"
        );
    });

    it("prints the same lines as renderTeamsTree", () => {
        const view = team("print", [mate("a")]);

        printTeamsList([view]);

        expect(printed).toEqual(renderTeamsTree([view]).map(stripAnsi));
    });
});

describe("runTeamsInteractive", () => {
    it("refuses to run without a terminal", async () => {
        state.interactive = false;

        await expect(runTeamsInteractive({})).rejects.toThrow("Interactive mode requires a TTY");
        expect(state.prompts).toEqual([]);
    });

    it("explains how to find teams when there are none", async () => {
        await runTeamsInteractive({});
        await runTeamsInteractive({ all: true });

        expect(printed).toEqual([
            "No agent teams found.",
            "Try --all, or cd into the project that owns the team.",
            "No agent teams found.",
            "Spawn teammates from a Claude Code session first.",
        ]);
        expect(state.discoverCalls).toEqual([{}, { all: true }]);
    });

    it("lists the teams in a table with one row per team plus refresh and quit", async () => {
        const failing = team("auth-team", [mate("a", { status: "not-logged-in" })], { tmuxSession: "main" });
        const running = team(
            "run-team",
            [mate("a", { status: "running", live: live(11), activity: "idle" }), mate("b", { activity: "idle" })],
            { cwd: "/work/acme", tmuxSession: "a-very-long-tmux-session-name" }
        );
        const quiet = team("quiet-team", [mate("a", { activity: "idle" })]);
        state.teams = [failing, running, quiet];
        state.answers = ["__quit__"];

        await runTeamsInteractive({ all: true });

        const prompt = state.prompts[0];
        expect(printed[0]).toBe("3 team(s) · all projects · ↑↓ select · enter · ↻ refresh");
        expect(prompt.message).toBe("Select team");
        expect(prompt.hint).toBe("(all projects)");
        expect(prompt.columns.map((c) => c.label)).toEqual(["TEAM", "LIVE", "N", "TMUX", "AGE"]);
        expect(prompt.rows.map((r) => r.value)).toEqual([
            "auth-team",
            "run-team",
            "quiet-team",
            "__refresh__",
            "__quit__",
        ]);
        expect(prompt.rows.map((r) => stripAnsi(r.badge ?? ""))).toEqual(["●", "●", "○", "↻", "×"]);
        expect(prompt.rows[1].cells.map(stripAnsi)).toEqual(["run-team", "1", "2", "a-very-long-tmux-…", "5m"]);
        expect(prompt.rows[2].cells.map(stripAnsi)).toEqual(["quiet-team", "0", "1", "—", "5m"]);
        expect(prompt.rows[1].detail?.map(stripAnsi)).toEqual(["/work/acme", "● run a  idle", "○ dead b  idle"]);
        expect(prompt.rows[2].detail?.map(stripAnsi)).toEqual(["(no cwd)", "○ dead a  idle"]);
    });

    it("shows at most six teammates and a count of the rest, and notes in-process teammates", async () => {
        const mates = Array.from({ length: 8 }, (_, i) => mate(`m${i}`, i === 7 ? { backend: "in-process" } : {}));
        state.teams = [team("big", mates)];
        state.answers = [null];

        await runTeamsInteractive({});

        const detail = state.prompts[0].rows[0].detail?.map(stripAnsi) ?? [];
        expect(state.prompts[0].hint).toBe("(this project) in-process attach re-invokes");
        expect(detail.filter((line) => line.startsWith("○ dead m"))).toHaveLength(6);
        expect(detail).toContain("… +2 more");
        expect(detail.at(-1)).toBe("in-process attach re-invokes: it does not restore the last tool call");
    });

    it("scans again on refresh and stops when the prompt is cancelled", async () => {
        state.teams = [team("one", [mate("a")])];
        state.answers = ["__refresh__", null];

        await runTeamsInteractive({});

        expect(state.discoverCalls).toHaveLength(2);
        expect(state.prompts).toHaveLength(2);
        expect(printed).toContain("");
    });

    it("tells the user when a chosen team vanished and returns to the list", async () => {
        state.teams = [team("gone", [mate("a")])];
        state.answers = ["gone", "__quit__"];

        await runTeamsInteractive({});

        expect(printed).toContain("Team gone not found.");
        expect(state.prompts.map((p) => p.message)).toEqual(["Select team", "Select team"]);
    });

    it("says when the chosen team has no teammates", async () => {
        const empty = team("empty", []);
        empty.config.description = "Quiet team";
        state.teams = [empty];
        state.byName.set("empty", empty);
        state.answers = ["empty", "__quit__"];

        await runTeamsInteractive({});

        expect(printed).toContain("empty");
        expect(printed).toContain("Quiet team");
        expect(printed).toContain("No teammates on this team.");
    });

    it("shows the teammates of the chosen team with the facts about each one", async () => {
        const alice = mate("alice", {
            status: "running",
            member: {
                agentId: "alice@team",
                name: "alice",
                model: "opus",
                prompt: "Review\n   the invoice   module",
                cwd: "/work/alice",
            },
            live: live(4242, { tmuxSession: "main", tmuxPaneId: "%3" }),
            activity: "reading",
            transcript: transcript({
                hasLeadAssignment: false,
                lastMessage: { role: "assistant", text: "Working\non it", isLeadAssignment: false },
            }),
        });
        const bob = mate("bob", {
            backend: "in-process",
            transcript: transcript({ lastMessage: { role: "user", text: "Go", isLeadAssignment: true } }),
        });
        const view = team("duo", [alice, bob], { cwd: "/work/team", tmuxSession: "main" });
        state.teams = [view];
        state.byName.set("duo", view);
        state.answers = ["duo", "__back__", "__quit__"];

        await runTeamsInteractive({});

        const prompt = state.prompts[1];
        expect(prompt.message).toBe("Teammates · duo");
        expect(prompt.hint).toBe("in-process attach re-invokes, it does not restore the last tool call");
        expect(prompt.columns.map((c) => c.label)).toEqual(["NAME", "STATUS", "MODEL", "BACKEND", "ACTIVITY"]);
        expect(prompt.rows.map((r) => r.value)).toEqual(["alice", "bob", "__back__"]);
        expect(prompt.rows[0].cells.map(stripAnsi)).toEqual(["alice", "running", "opus", "tmux", "reading"]);
        expect(prompt.rows[1].cells.map(stripAnsi)).toEqual(["bob", "dead", "—", "in-process", ""]);
        expect(prompt.rows[0].detail?.map(stripAnsi)).toEqual([
            "id alice@team",
            "live pid 4242 · main:%3",
            "transcript abcdef12 · 12 msgs · NO assignment",
            "prompt: Review the invoice module",
            "assistant: Working on it",
            "First assignment missing: attach/split will inject prompt",
            "cwd /work/alice",
        ]);
        expect(prompt.rows[1].detail?.map(stripAnsi)).toEqual([
            "id bob@team",
            "not running",
            "transcript abcdef12 · 12 msgs · has assignment",
            "assign: Go",
            "in-process: attach/split does not restore the last tool call (new session, or lead resume)",
            "cwd /work/team",
        ]);
    });

    it("uses the plain hint and a dash for the working directory when nothing is in-process or known", async () => {
        const view = team("plain", [mate("a")]);
        state.teams = [view];
        state.byName.set("plain", view);
        state.answers = ["plain", null];

        await runTeamsInteractive({});

        expect(state.prompts[1].hint).toBe("(enter to act)");
        expect(state.prompts[1].rows[0].detail?.map(stripAnsi).at(-1)).toBe("cwd —");
    });

    it("goes back to the list when the teammate prompt is cancelled or the name is unknown", async () => {
        const view = team("pick", [mate("a")]);
        state.teams = [view];
        state.byName.set("pick", view);
        state.answers = ["pick", null, "pick", "nobody", "__quit__"];

        await runTeamsInteractive({});

        expect(state.prompts.map((p) => p.message)).toEqual([
            "Select team",
            "Teammates · pick",
            "Select team",
            "Teammates · pick",
            "Select team",
        ]);
        expect(state.launchCalls).toEqual([]);
    });
});

describe("runTeamsInteractive teammate actions", () => {
    function open(extra: { mates?: TeamMemberView[]; tmuxSession?: string } = {}): TeamView {
        const opened = team("acts", extra.mates ?? [mate("alice", { status: "idle" })], {
            tmuxSession: extra.tmuxSession,
        });
        state.teams = [opened];
        state.byName.set("acts", opened);
        return opened;
    }

    it("offers the four actions with the command and the plan for each", async () => {
        open({ tmuxSession: "main" });
        state.answers = ["acts", "alice", "back", "__quit__"];

        await runTeamsInteractive({ account: "work" });

        const prompt = state.prompts[2];
        expect(prompt.message).toBe("alice · acts");
        expect(prompt.hint).toBe("account work");
        expect(prompt.rows.map((r) => r.value)).toEqual(["focus", "split", "attach", "print", "back"]);
        expect(prompt.rows.map((r) => stripAnsi(r.cells[0]))).toEqual([
            "Focus live pane (not running)",
            "Split lead tmux pane + launch with OAuth",
            "Launch / re-attach (new window or foreground)",
            "Print command only",
            "← back",
        ]);
        expect(prompt.rows[1].detail?.map(stripAnsi)).toEqual([
            "will inject lead assignment after boot",
            "lead tmux main",
            "tools cc run work acts alice",
        ]);
    });

    it("plans a resume when the teammate's transcript already holds the lead assignment", async () => {
        open({ mates: [mate("alice", { transcript: transcript({ hasLeadAssignment: true }) })] });
        state.answers = ["acts", "alice", "back", "__quit__"];

        await runTeamsInteractive({ account: "work" });

        const split = state.prompts[2].rows[1];
        expect(split.detail?.map(stripAnsi)).toEqual([
            "will --resume abcdef12",
            "No lead tmux session detected",
            "tools cc run work acts alice",
        ]);
    });

    it("warns against spawning a second process for an in-process teammate that is still live", async () => {
        const busy = mate("alice", {
            backend: "in-process",
            transcript: transcript({ sidechain: true, mtimeMs: Date.now() }),
        });
        open({ mates: [busy] });
        state.answers = ["acts", "alice", "back", "__quit__"];

        await runTeamsInteractive({ account: "work" });

        const prompt = state.prompts[2];
        expect(prompt.hint).toBe("account work · in-process attach re-invokes, it does not restore the last tool call");
        expect(stripAnsi(prompt.rows[0].cells[0])).toBe("Focus live pane (select in tmux)");
        expect(prompt.rows[0].detail?.map(stripAnsi)).toContain(
            "in-process: focus the lead pane. Do not attach-spawn."
        );
        expect(stripAnsi(prompt.rows[1].cells[0])).toBe("Do not split-spawn: that starts a new session and re-invokes");
        expect(stripAnsi(prompt.rows[2].cells[0])).toBe("Do not spawn: in-process still live (attach would re-invoke)");
    });

    it("says an idle in-process teammate can only resume the lead", async () => {
        open({ mates: [mate("alice", { backend: "in-process" })] });
        state.answers = ["acts", "alice", "back", "__quit__"];

        await runTeamsInteractive({ account: "work" });

        expect(stripAnsi(state.prompts[2].rows[2].cells[0])).toBe(
            "Resume lead only: in-process attach does not restore last tool call"
        );
    });

    it("prints the command without launching anything", async () => {
        open();
        state.answers = ["acts", "alice", "print", "__quit__"];

        await runTeamsInteractive({ account: "work" });

        expect(printed).toContain("Command:");
        expect(printed).toContain("tools cc run work acts alice");
        expect(state.launchCalls).toEqual([]);
    });

    it("refuses to focus a teammate that is not running", async () => {
        open();
        state.answers = ["acts", "alice", "focus", "__quit__"];

        await runTeamsInteractive({ account: "work" });

        expect(printed).toContain("Teammate is not running. Use split or attach.");
        expect(state.launchCalls).toEqual([]);
    });

    it("launches the chosen action and prints the result with its command", async () => {
        const opened = open({
            mates: [mate("alice", { member: { agentId: "alice@team", name: "alice", prompt: "Do it" } })],
        });
        state.answers = ["acts", "alice", "split", "__quit__"];

        await runTeamsInteractive({ account: "work" });

        expect(state.launchCalls).toHaveLength(1);
        expect(state.launchCalls[0]).toMatchObject({
            account: "work",
            mode: "split",
            team: opened,
            teammate: opened.teammates[0],
        });
        expect(printed).toContain("✓ Launched in a new window");
        expect(printed).toContain("tools cc run work");
        expect(printed).toContain(
            "If the mate boots empty, the lead assignment is injected when missing from the transcript."
        );
    });

    it("does not print the command or the boot hint after a focus, and marks a no-op", async () => {
        open({ mates: [mate("alice", { live: live(77) })] });
        state.launchResult = { action: "noop", detail: "Already focused", command: "tools cc run work" };
        state.answers = ["acts", "alice", "focus", "__quit__"];

        await runTeamsInteractive({ account: "work" });

        expect(printed).toContain("• Already focused");
        expect(printed).not.toContain("tools cc run work");
        expect(state.launchCalls[0]?.mode).toBe("focus");
    });

    it("reports a launch that throws and returns to the list", async () => {
        open();
        state.launchError = new Error("tmux is not running");
        state.answers = ["acts", "alice", "attach", "__quit__"];

        await runTeamsInteractive({ account: "work" });

        expect(printed).toContain("tmux is not running");
        expect(state.prompts.at(-1)?.message).toBe("Select team");
    });

    it("takes the account from a running teammate's environment, then the lead's, then the default", async () => {
        const runner = mate("alice", { live: live(501) });
        const withEnv = open({ mates: [mate("idle-mate"), runner] });
        state.env = { 501: { TOOLS_CLAUDE_ACCOUNT: "from-mate" } };
        state.answers = ["acts", "alice", "print", "__quit__"];
        await runTeamsInteractive({});
        expect(state.prompts[2].hint).toBe("account from-mate");

        state.prompts = [];
        withEnv.lead = mate("team-lead", { isLead: true, live: live(502) });
        withEnv.teammates = [mate("alice")];
        state.byName.set("acts", withEnv);
        state.env = { 502: { TOOLS_CLAUDE_ACCOUNT: "from-lead" } };
        state.answers = ["acts", "alice", "print", "__quit__"];
        await runTeamsInteractive({});
        expect(state.prompts[2].hint).toBe("account from-lead");

        state.prompts = [];
        state.env = {};
        state.answers = ["acts", "alice", "print", "__quit__"];
        await runTeamsInteractive({});
        expect(state.prompts[2].hint).toBe("account default-acct");
    });
});
