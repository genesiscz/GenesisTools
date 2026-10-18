import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { homedir } from "node:os";
import * as realCachedTitle from "@genesiscz/utils/agent-sessions/cached-title";
import { SafeJSON } from "@genesiscz/utils/json";
import * as realCodexRollouts from "@genesiscz/utils/session-changes/codex";
import { Command } from "commander";
import * as realAccountsContext from "../accounts-context";
import * as realConfig from "../config";
import { DEFAULT_PRICING } from "../pricing";
import { pricedEventCost } from "./load";
import * as realLoadParallel from "./load-parallel";
import type { SpendEvent } from "./types";

type LoadOptions = Parameters<typeof realLoadParallel.loadEventsParallel>[0];
type SessionResolution = ReturnType<typeof realCachedTitle.resolveCachedSessionId>;

const DAY_MS = 24 * 60 * 60 * 1000;

const loadCalls: LoadOptions[] = [];
const accountCalls: Array<{ allHomes?: boolean }> = [];
let fixtureEvents: SpendEvent[] = [];
let sessionResolution: SessionResolution = { kind: "none" };
let codexRollouts = new Map<string, string>();

mock.module("./load-parallel", () => ({
    ...realLoadParallel,
    loadEventsParallel: async (options: LoadOptions) => {
        loadCalls.push(options);
        return fixtureEvents.filter((fixture) => !options.sources || options.sources.includes(fixture.source));
    },
}));

mock.module("../accounts-context", () => ({
    ...realAccountsContext,
    loadSpendAccountsContext: async (options: { allHomes?: boolean } = {}) => {
        accountCalls.push(options);
        return { accounts: [] };
    },
}));

mock.module("../config", () => ({
    ...realConfig,
    loadPricing: async () => DEFAULT_PRICING,
}));

mock.module("@genesiscz/utils/agent-sessions/cached-title", () => ({
    ...realCachedTitle,
    resolveCachedSessionId: () => sessionResolution,
}));

mock.module("@genesiscz/utils/session-changes/codex", () => ({
    ...realCodexRollouts,
    findCodexRollout: (threadId: string) => codexRollouts.get(threadId) ?? null,
}));

const { addAccountFlags, addReportFlags, registerCcusageCommands } = await import("./commands");

function event(overrides: Partial<SpendEvent> = {}): SpendEvent {
    return {
        source: "claude",
        id: "evt-1",
        model: "claude-opus-4-8",
        timestamp: "2026-09-07T10:00:00.000Z",
        sessionId: "sess-a",
        project: "acme/widgets",
        inputTokens: 1000,
        outputTokens: 200,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        recordedCostUsd: 1.5,
        ...overrides,
    };
}

function daysAgo(days: number): string {
    return new Date(Date.now() - days * DAY_MS).toISOString();
}

interface PeriodRowJson {
    period: string;
    totalCost: number;
    inputTokens: number;
    agents?: Array<{ agent: string; totalCost: number }>;
}

/** The per-source form of a period row: `tools ai-spend codex daily` reports `date` and `costUSD`. */
interface SourceRowJson {
    date: string;
    costUSD: number;
}

interface Totals {
    totalCost: number;
    totalTokens: number;
}

interface CodexAnalysisJson {
    passes: unknown[];
    totals: { costUSD: number; requests: number };
}

interface PeriodReportJson {
    daily?: PeriodRowJson[];
    weekly?: PeriodRowJson[];
    monthly?: PeriodRowJson[];
    session?: PeriodRowJson[];
    totals?: Totals;
    analysis?: CodexAnalysisJson;
}

interface SourceReportJson {
    daily?: SourceRowJson[];
    session?: SourceRowJson[];
    analysis?: CodexAnalysisJson;
}

interface BlocksJson {
    blocks: Array<{ isGap: boolean; entries: number; costUSD: number }>;
}

function required<T>(value: T | undefined, what: string): T {
    if (value === undefined) {
        throw new Error(`report has no ${what}`);
    }

    return value;
}

let stdout = "";
let stderr = "";
let previousExitCode: typeof process.exitCode;
const spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
    loadCalls.length = 0;
    accountCalls.length = 0;
    fixtureEvents = [];
    sessionResolution = { kind: "none" };
    codexRollouts = new Map();
    stdout = "";
    stderr = "";
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    spies.push(
        spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
            stdout += String(chunk);
            return true;
        }),
        spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
            stderr += String(chunk);
            return true;
        })
    );
});

afterEach(() => {
    process.exitCode = previousExitCode;

    for (const spy of spies.splice(0)) {
        spy.mockRestore();
    }
});

function buildProgram(): Command {
    const program = new Command();
    program.exitOverride();
    registerCcusageCommands(program);

    return program;
}

async function run(...argv: string[]): Promise<void> {
    await buildProgram().parseAsync(argv, { from: "user" });
}

async function runJson<T>(...argv: string[]): Promise<T> {
    stdout = "";
    await run(...argv, "--json", "--timezone", "UTC");

    return SafeJSON.parse(stdout, { strict: true }) as T;
}

function subcommand(path: string[]): Command {
    let node = buildProgram();

    for (const name of path) {
        const child = node.commands.find((candidate) => candidate.name() === name);

        if (!child) {
            throw new Error(`no \`${name}\` command under \`${node.name()}\``);
        }

        node = child;
    }

    return node;
}

function longFlags(cmd: Command): string[] {
    return cmd.options.map((option) => option.long ?? "");
}

describe("addReportFlags", () => {
    test("every report takes the output, date, grouping and account flags", () => {
        const cmd = addReportFlags(new Command(), {});

        expect(longFlags(cmd)).toEqual([
            "--json",
            "--since",
            "--until",
            "--timezone",
            "--by-agent",
            "--all-homes",
            "--account",
        ]);
    });

    test("--last, --breakdown, --mode, --id and the block flags are opt-in", () => {
        const cmd = addReportFlags(new Command(), {
            last: true,
            breakdown: true,
            mode: true,
            sessionId: true,
            blocks: true,
        });

        expect(longFlags(cmd)).toEqual(
            expect.arrayContaining([
                "--last",
                "--breakdown",
                "--mode",
                "--id",
                "--active",
                "--recent",
                "--session-length",
            ])
        );
        expect(longFlags(addReportFlags(new Command(), { last: true }))).not.toContain("--breakdown");
        expect(longFlags(addReportFlags(new Command(), { blocks: true }))).not.toContain("--mode");
    });

    test("the session block length defaults to five hours", () => {
        const cmd = addReportFlags(new Command(), { blocks: true });
        cmd.parse([], { from: "user" });

        expect(cmd.opts().sessionLength).toBe("5");
    });

    test("--account takes several ids and --all-homes is a plain switch", () => {
        const cmd = addAccountFlags(new Command());
        cmd.parse(["--account", "work", "personal", "--all-homes"], { from: "user" });

        expect(cmd.opts()).toEqual({ account: ["work", "personal"], allHomes: true });
    });
});

describe("registerCcusageCommands", () => {
    test("registers the period, session, blocks and statusline reports and one group per source", () => {
        const names = buildProgram().commands.map((cmd) => cmd.name());

        expect(names).toEqual(
            expect.arrayContaining(["daily", "weekly", "monthly", "session", "blocks", "statusline", "claude", "codex"])
        );
    });

    test("--mode exists only for claude, --last only on period reports, --id only on session and reviews", () => {
        expect(longFlags(subcommand(["claude", "daily"]))).toContain("--mode");
        expect(longFlags(subcommand(["codex", "daily"]))).not.toContain("--mode");
        expect(longFlags(subcommand(["codex", "daily"]))).toContain("--last");
        expect(longFlags(subcommand(["codex", "session"]))).not.toContain("--last");
        expect(longFlags(subcommand(["codex", "session"]))).toContain("--id");
        expect(longFlags(subcommand(["codex", "reviews"]))).toContain("--id");
        expect(longFlags(subcommand(["codex", "daily"]))).not.toContain("--id");
        expect(longFlags(subcommand(["claude", "blocks"]))).toContain("--session-length");
        expect(longFlags(subcommand(["claude", "statusline"]))).toContain("--visual-burn-rate");
    });
});

describe("period reports", () => {
    const twoDays = (): SpendEvent[] => [
        event(),
        event({ id: "evt-2", timestamp: "2026-09-08T10:00:00.000Z", sessionId: "sess-b", recordedCostUsd: 2 }),
    ];

    test("daily groups events by day and totals them as JSON", async () => {
        fixtureEvents = twoDays();

        const report = await runJson<PeriodReportJson>("daily");

        expect(required(report.daily, "daily rows").map((row) => [row.period, row.totalCost, row.inputTokens])).toEqual(
            [
                ["2026-09-07", 1.5, 1000],
                ["2026-09-08", 2, 1000],
            ]
        );
        expect(required(report.totals, "totals")).toMatchObject({ totalCost: 3.5, totalTokens: 2400 });
    });

    test("the human table lists each day and a total row, and --breakdown adds a row per model", async () => {
        fixtureEvents = [event(), event({ id: "evt-2", model: "gpt-6-astra", recordedCostUsd: 2 })];

        await run("daily", "--timezone", "UTC");
        const plain = stdout;
        stdout = "";
        await run("daily", "--timezone", "UTC", "--breakdown");
        const modelLines = (text: string): number =>
            text.split("\n").filter((line) => line.includes("gpt-6-astra")).length;

        expect(plain).toContain("2026-09-07");
        expect(plain).toContain("$3.5000");
        expect(plain).toContain("Total");
        expect(plain).toContain("claude-opus-4-8, gpt-6-astra");
        expect(modelLines(stdout)).toBeGreaterThan(modelLines(plain));
    });

    test("weekly and monthly use their own grain", async () => {
        fixtureEvents = twoDays();

        const weekly = await runJson<PeriodReportJson>("weekly");
        const monthly = await runJson<PeriodReportJson>("monthly");

        expect(required(weekly.weekly, "weekly rows").map((row) => row.period)).toEqual(["2026-09-07"]);
        expect(required(monthly.monthly, "monthly rows").map((row) => [row.period, row.totalCost])).toEqual([
            ["2026-09", 3.5],
        ]);
    });

    test("--since and --until bound the report, and --since also bounds the transcript scan to 3 days earlier", async () => {
        fixtureEvents = twoDays();

        const sinceOnly = await runJson<PeriodReportJson>("daily", "--since", "2026-09-08");

        expect(required(sinceOnly.daily, "daily rows").map((row) => row.period)).toEqual(["2026-09-08"]);
        expect(loadCalls[0].minMtimeMs).toBe(Date.parse("2026-09-08T00:00:00.000Z") - 3 * DAY_MS);

        const untilOnly = await runJson<PeriodReportJson>("daily", "--until", "20260907");

        expect(required(untilOnly.daily, "daily rows").map((row) => row.period)).toEqual(["2026-09-07"]);
        expect(loadCalls[1].minMtimeMs).toBe(0);
    });

    test("a relative --since such as 3d is accepted and limits the scan to recent files", async () => {
        fixtureEvents = [event({ timestamp: daysAgo(1) }), event({ id: "evt-old", timestamp: daysAgo(30) })];

        const report = await runJson<PeriodReportJson>("daily", "--since", "3d");

        expect(process.exitCode ?? 0).toBe(0);
        expect(required(report.daily, "daily rows")).toHaveLength(1);
        expect(loadCalls[0].minMtimeMs).toBeGreaterThan(Date.now() - 8 * DAY_MS);
        expect(loadCalls[0].minMtimeMs).toBeLessThan(Date.now() - 5 * DAY_MS);
    });

    test("--last N keeps only the newest N periods", async () => {
        fixtureEvents = [
            event({ timestamp: daysAgo(0) }),
            event({ id: "evt-mid", timestamp: daysAgo(2) }),
            event({ id: "evt-old", timestamp: daysAgo(40) }),
        ];

        const lastThree = await runJson<PeriodReportJson>("daily", "--last", "3");
        const monthlyOne = await runJson<PeriodReportJson>("monthly", "--last", "1");

        expect(required(lastThree.daily, "daily rows")).toHaveLength(2);
        expect(required(monthlyOne.monthly, "monthly rows")).toHaveLength(1);
    });

    test("--by-agent adds a row per agent inside each period", async () => {
        fixtureEvents = [event(), event({ id: "evt-2", source: "codex", model: "gpt-6-astra", recordedCostUsd: 2 })];

        const report = await runJson<PeriodReportJson>("daily", "--by-agent");

        expect(required(report.daily, "daily rows")[0].agents?.map((agent) => [agent.agent, agent.totalCost])).toEqual([
            ["claude", 1.5],
            ["codex", 2],
        ]);
    });

    test("the cost mode changes how an event is priced", async () => {
        const priced = event({ recordedCostUsd: 99 });
        fixtureEvents = [priced];
        const calculated = pricedEventCost(priced, DEFAULT_PRICING, "calculate");

        const report = await runJson<BlocksJson>("blocks", "--mode", "calculate");

        expect(calculated).not.toBe(99);
        expect(report.blocks[0].costUSD).toBe(calculated);
    });

    test("a source group asks the loader for that source only", async () => {
        fixtureEvents = [event(), event({ id: "evt-2", source: "codex", model: "gpt-6-astra", recordedCostUsd: 2 })];

        const report = await runJson<SourceReportJson>("codex", "daily");

        expect(loadCalls[0].sources).toEqual(["codex"]);
        expect(required(report.daily, "daily rows").map((row) => [row.date, row.costUSD])).toEqual([["2026-09-07", 2]]);
        expect(required(report.analysis, "analysis").totals).toMatchObject({ requests: 1, costUSD: 2 });
    });

    test("the loader is told the home directory and whether to walk unclaimed homes", async () => {
        await runJson<PeriodReportJson>("daily", "--all-homes");
        await runJson<PeriodReportJson>("daily");

        expect(loadCalls[0].home).toBe(homedir());
        expect(accountCalls).toEqual([{ allHomes: true }, { allHomes: undefined }]);
    });

    test("--account keeps only events that report under those account ids", async () => {
        fixtureEvents = [
            event({ id: "evt-claude" }),
            event({ id: "evt-work", source: "codex", accountId: "work", recordedCostUsd: 2 }),
            event({ id: "evt-personal", source: "codex", accountId: "personal", recordedCostUsd: 4 }),
            event({ id: "evt-unbound", source: "codex", recordedCostUsd: 8 }),
        ];

        const report = await runJson<PeriodReportJson>("daily", "--account", "work", "(unbound)");

        expect(required(report.daily, "daily rows")[0].totalCost).toBe(10);
    });
});

describe("report option errors", () => {
    test.each([
        [["daily", "--since", "yesterday"], "Invalid --since yesterday. Use YYYY-MM-DD, YYYYMMDD, or Nd."],
        [["daily", "--until", "2026-13-40"], "Invalid --until 2026-13-40. Use YYYY-MM-DD or YYYYMMDD."],
        [["daily", "--timezone", "Mars/Olympus"], "Invalid --timezone Mars/Olympus. Use an IANA timezone name."],
    ])("%j is refused before any transcript is read", async (argv, message) => {
        await run(...argv);

        expect(stderr).toContain(message);
        expect(process.exitCode).toBe(1);
        expect(loadCalls).toEqual([]);
        expect(stdout).toBe("");
    });

    test.each([[["--mode", "bogus"]], [["--mode"]]])("blocks %j names the allowed cost modes", async (argv) => {
        await run("blocks", ...argv);

        expect(stderr).toContain("--mode");
        expect(stderr).toContain("calculate");
        expect(process.exitCode).toBe(1);
        expect(loadCalls).toEqual([]);
    });
});

describe("session reports", () => {
    const sessions = (): SpendEvent[] => [
        event(),
        event({ id: "evt-2", sessionId: "sess-b", timestamp: "2026-09-08T10:00:00.000Z", recordedCostUsd: 2 }),
    ];

    test("lists one row per session, newest first, without reading a single session's files", async () => {
        fixtureEvents = sessions();

        const report = await runJson<PeriodReportJson>("session");

        expect(required(report.session, "session rows").map((row) => [row.period, row.totalCost])).toEqual([
            ["sess-b", 2],
            ["sess-a", 1.5],
        ]);
        expect(loadCalls[0].sessionId).toBeUndefined();
    });

    test("--id narrows the loader and the report to that session", async () => {
        fixtureEvents = sessions();

        const report = await runJson<PeriodReportJson>("session", "--id", "sess-b");

        expect(required(report.session, "session rows").map((row) => row.period)).toEqual(["sess-b"]);
        expect(loadCalls[0].sessionId).toBe("sess-b");
        expect(stderr).not.toContain("No usage found");
    });

    test("a leading part of an id resolves to the full id and says so", async () => {
        fixtureEvents = sessions();
        sessionResolution = {
            kind: "unique",
            sessionId: "sess-b",
            match: { sessionId: "sess-b", providerId: "claude", title: "Widgets", mtime: 1 },
        };

        const report = await runJson<PeriodReportJson>("session", "--id", "sess-");

        expect(loadCalls[0].sessionId).toBe("sess-b");
        expect(required(report.session, "session rows").map((row) => row.period)).toEqual(["sess-b"]);
        expect(stderr).toContain("--id sess- is session sess-b");
    });

    test("a Codex thread id becomes its rollout name", async () => {
        const thread = "019a1234-aaaa-bbbb-cccc-1234567890ab";
        const rollout = `rollout-2026-09-07T10-00-00-${thread}`;
        codexRollouts.set(thread, `/fixture/codex/sessions/${rollout}.jsonl`);
        fixtureEvents = [event({ source: "codex", sessionId: rollout })];

        await runJson<PeriodReportJson>("codex", "session", "--id", thread);

        expect(loadCalls[0].sessionId).toBe(rollout);
        expect(stderr).toContain(`--id ${thread} is Codex rollout ${rollout}`);
    });

    test("an ambiguous id lists the candidates and reads nothing", async () => {
        sessionResolution = {
            kind: "ambiguous",
            candidates: [
                { sessionId: "sess-aaa", providerId: "claude", title: "First", mtime: 2 },
                { sessionId: "sess-abb", providerId: "codex", title: "Second", mtime: 1 },
            ],
        };

        await run("session", "--id", "sess-a");

        expect(stderr).toContain("--id sess-a matches more than one session. Pass more of the id:");
        expect(stderr).toContain("sess-aaa  claude  First");
        expect(stderr).toContain("sess-abb  codex  Second");
        expect(process.exitCode).toBe(1);
        expect(loadCalls).toEqual([]);
    });

    test("an id nothing matches warns that every total is zero", async () => {
        fixtureEvents = sessions();

        await run("session", "--id", "nothing-here", "--timezone", "UTC");

        expect(stderr).toContain("No usage found for session nothing-here: every total below is zero");
        expect(process.exitCode ?? 0).toBe(0);
    });
});

describe("blocks report", () => {
    test("groups claude events into billing windows and shows the idle gap between them", async () => {
        fixtureEvents = [
            event({ timestamp: "2026-09-07T10:00:00.000Z" }),
            event({ id: "evt-codex", source: "codex", timestamp: "2026-09-07T10:05:00.000Z" }),
            event({ id: "evt-2", timestamp: "2026-09-08T10:00:00.000Z", recordedCostUsd: 2 }),
        ];

        const report = await runJson<BlocksJson>("blocks");

        expect(report.blocks.map((block) => [block.isGap, block.entries, block.costUSD])).toEqual([
            [false, 1, 1.5],
            [true, 0, 0],
            [false, 1, 2],
        ]);
    });

    test("--session-length sets the window, and a value that is not a number falls back to 5 hours", async () => {
        fixtureEvents = [
            event({ timestamp: "2026-09-07T10:00:00.000Z" }),
            event({ id: "evt-2", timestamp: "2026-09-07T13:00:00.000Z" }),
        ];
        const realBlocks = (report: BlocksJson): number => report.blocks.filter((block) => !block.isGap).length;

        const fiveHours = await runJson<BlocksJson>("blocks");
        const twoHours = await runJson<BlocksJson>("blocks", "--session-length", "2");
        const garbage = await runJson<BlocksJson>("blocks", "--session-length", "soon");

        expect(realBlocks(fiveHours)).toBe(1);
        expect(realBlocks(twoHours)).toBe(2);
        expect(realBlocks(garbage)).toBe(1);
    });

    test("the human table names each block and the gap", async () => {
        fixtureEvents = [
            event({ timestamp: "2026-09-07T10:00:00.000Z" }),
            event({ id: "evt-2", timestamp: "2026-09-08T10:00:00.000Z", recordedCostUsd: 2 }),
        ];

        await run("blocks", "--timezone", "UTC");

        expect(stdout).toContain("2026-09-07T10:00:00");
        expect(stdout).toContain("gap 2026-09-07T15:00");
        expect(stdout).toContain("$2.0000");
    });
});

describe("codex reviews report", () => {
    test("prints the analysis as JSON, counting requests and cost of codex events only", async () => {
        fixtureEvents = [event(), event({ id: "evt-2", source: "codex", model: "gpt-6-astra", recordedCostUsd: 2 })];

        const analysis = await runJson<CodexAnalysisJson>("codex", "reviews");

        expect(loadCalls[0].sources).toEqual(["codex"]);
        expect(analysis.passes).toEqual([]);
        expect(analysis.totals).toMatchObject({ requests: 1, costUSD: 2 });
    });

    test("prints the tables and the estimate caveat in the terminal form", async () => {
        fixtureEvents = [event({ source: "codex", model: "gpt-6-astra", recordedCostUsd: 2 })];

        await run("codex", "reviews", "--timezone", "UTC");

        expect(stdout).toContain("gpt-6-astra");
        expect(stdout).toContain("Total estimate: $2.0000");
        expect(stdout).toContain("API-equivalent estimates");
    });

    test("--id limits the loader to that rollout", async () => {
        fixtureEvents = [event({ source: "codex", sessionId: "rollout-x" })];

        await run("codex", "reviews", "--id", "rollout-x", "--json", "--timezone", "UTC");

        expect(loadCalls[0].sessionId).toBe("rollout-x");
    });

    test("a codex session report appends the analysis tables after the session table", async () => {
        fixtureEvents = [event({ source: "codex", model: "gpt-6-astra", recordedCostUsd: 2 })];

        await run("codex", "session", "--timezone", "UTC");

        expect(stdout.indexOf("SESSION")).toBeGreaterThanOrEqual(0);
        expect(stdout.indexOf("Total estimate")).toBeGreaterThan(stdout.indexOf("SESSION"));
    });

    test("a codex daily report appends the analysis tables after the daily table", async () => {
        fixtureEvents = [event({ source: "codex", model: "gpt-6-astra", recordedCostUsd: 2 })];

        await run("codex", "daily", "--timezone", "UTC");

        expect(stdout).toContain("2026-09-07");
        expect(stdout.indexOf("Total estimate: $2.0000")).toBeGreaterThan(stdout.indexOf("2026-09-07"));
    });

    test("the JSON session report carries the codex analysis in the same document", async () => {
        fixtureEvents = [event({ source: "codex", model: "gpt-6-astra", recordedCostUsd: 2 })];

        const report = await runJson<SourceReportJson>("codex", "session");

        expect(required(report.analysis, "analysis").totals.requests).toBe(1);
    });
});

describe("statusline", () => {
    const hook = SafeJSON.stringify({
        session_id: "sess-a",
        model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
        cost: { total_cost_usd: 1.5 },
        context_window: { total_input_tokens: 1000, context_window_size: 200000 },
    });

    function feedStdin(text: string): void {
        spies.push(spyOn(Bun.stdin, "stream").mockImplementation(() => new Blob([text]).stream()));
        Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    }

    afterEach(() => {
        Reflect.deleteProperty(process.stdin, "isTTY");
    });

    test("prints one line for the hook JSON on stdin and scans only the last two days of transcripts", async () => {
        feedStdin(hook);
        const before = Date.now();

        await run("statusline", "--timezone", "UTC");

        expect(stdout).toBe("🤖 Opus 4.8 | 💰 $1.50 session / $0.00 today / No active block | 🧠 1,000 (1%)\n");
        expect(loadCalls[0].minMtimeMs).toBeGreaterThanOrEqual(before - 2 * DAY_MS);
        expect(loadCalls[0].minMtimeMs).toBeLessThanOrEqual(Date.now() - 2 * DAY_MS);
    });

    test("reads claude usage only, whatever the loader returns", async () => {
        fixtureEvents = [event({ id: "evt-codex", source: "codex", timestamp: daysAgo(0), recordedCostUsd: 40 })];
        feedStdin(hook);

        await run("statusline", "--timezone", "UTC");

        expect(stdout).toContain("$0.00 today");
        expect(stdout).not.toContain("$40");
    });

    test("with nothing on stdin it says how to feed it and fails", async () => {
        feedStdin("   ");

        await run("statusline", "--timezone", "UTC");

        expect(stderr).toContain("No input provided. Pipe Claude Code hook JSON on stdin.");
        expect(process.exitCode).toBe(1);
        expect(stdout).toBe("");
    });

    test("a terminal on stdin means no input, and stdin is never read", async () => {
        const stream = spyOn(Bun.stdin, "stream");
        spies.push(stream);
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

        await run("statusline", "--timezone", "UTC");

        expect(stream).not.toHaveBeenCalled();
        expect(stderr).toContain("No input provided");
        expect(process.exitCode).toBe(1);
    });

    test("a hook without a session id counts as no input", async () => {
        feedStdin(SafeJSON.stringify({ model: { id: "claude-opus-4-8" } }));

        await run("statusline", "--timezone", "UTC");

        expect(stderr).toContain("No input provided");
        expect(process.exitCode).toBe(1);
    });

    test("an unknown --visual-burn-rate lists the allowed values", async () => {
        feedStdin(hook);

        await run("statusline", "--timezone", "UTC", "--visual-burn-rate", "rainbow");

        expect(stderr).toContain("--visual-burn-rate");
        expect(stderr).toContain("emoji-text");
        expect(process.exitCode).toBe(1);
        expect(stdout).toBe("");
    });

    test.each(["off", "emoji", "text", "emoji-text"])("--visual-burn-rate %s is accepted", async (style) => {
        feedStdin(hook);

        await run("statusline", "--timezone", "UTC", "--visual-burn-rate", style);

        expect(process.exitCode ?? 0).toBe(0);
        expect(stdout).toContain("Opus 4.8");
    });

    test("a bare -B is accepted, and the per-source form reads claude usage only", async () => {
        feedStdin(hook);

        await run("claude", "statusline", "--timezone", "UTC", "-B");

        expect(process.exitCode ?? 0).toBe(0);
        expect(loadCalls[0].sources).toEqual(["claude"]);
        expect(stdout).toContain("Opus 4.8");
    });
});
