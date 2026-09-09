import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { filtersFromHistoryOptions, registerAgentHistoryCommand } from "./history-cli";
import type { AgentSessionAdapter, NativeIndexStatus } from "./types";

afterEach(() => {
    spyOn(out, "print").mockRestore();
    spyOn(out, "result").mockRestore();
    spyOn(out, "println").mockRestore();
});

describe("filtersFromHistoryOptions", () => {
    test("defaults cwd to the process cwd unless --all", () => {
        const scoped = filtersFromHistoryOptions("restore", { limit: "5" }, "/Users/me/Projects/shop");
        expect(scoped.cwd).toBe("/Users/me/Projects/shop");
        expect(scoped.limit).toBe(5);
        expect(scoped.query).toBe("restore");

        const byLeaf = filtersFromHistoryOptions("restore", { project: "GenesisTools" }, "/Users/me/Projects/shop");
        expect(byLeaf.cwd).toBeUndefined();
        expect(byLeaf.project).toBe("GenesisTools");

        const all = filtersFromHistoryOptions(undefined, { all: true }, "/Users/me/Projects/shop");
        expect(all.cwd).toBeUndefined();
        expect(all.all).toBe(true);
    });
});

describe("filtersFromHistoryOptions --project", () => {
    test("--project fills the project filter, not cwd", () => {
        // It used to land in `cwd`, which is compared against the ABSOLUTE path,
        // so `-p GenesisTools` matched nothing and printed "No conversations".
        const filters = filtersFromHistoryOptions("rebase", { project: "shop" }, "/Users/me/Projects/other");

        expect(filters.project).toBe("shop");
        expect(filters.cwd).toBeUndefined();
    });

    test("--cwd still pins the absolute directory", () => {
        const filters = filtersFromHistoryOptions(undefined, { cwd: "/Users/me/Projects/shop" }, "/Users/me/other");

        expect(filters.cwd).toBe("/Users/me/Projects/shop");
        expect(filters.project).toBeUndefined();
    });

    test("--all wins over --project", () => {
        const filters = filtersFromHistoryOptions(undefined, { all: true, project: "shop" }, "/Users/me/other");

        expect(filters.project).toBeUndefined();
        expect(filters.cwd).toBeUndefined();
    });
});

test("rich history filters preserve tool, files, context, commit and exclusion intent", () => {
    const filters = filtersFromHistoryOptions(
        "refund",
        {
            file: ["*.ts"],
            files: ["*.sql"],
            tool: "Edit",
            context: "2",
            summaryOnly: true,
            excludeThinking: true,
            excludeAgents: true,
            excludeSession: ["session-1"],
            commit: "abcdef1",
            commitMsg: "rounding fix",
            sortRelevance: true,
            convDate: "2026-09-01",
            convDateUntil: "2026-09-07",
        },
        "/projects/shop"
    );
    expect(filters.files).toEqual(["*.ts", "*.sql"]);
    expect(filters.tool).toBe("Edit");
    expect(filters.context).toBe(2);
    expect(filters.summaryOnly).toBe(true);
    expect(filters.excludeThinking).toBe(true);
    expect(filters.excludeAgents).toBe(true);
    expect(filters.excludeSessions).toEqual(["session-1"]);
    expect(filters.commitHash).toBe("abcdef1");
    expect(filters.commitMessage).toBe("rounding fix");
    expect(filters.sortByRelevance).toBe(true);
    expect(filters.conversationDate?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
});

test("invalid history limits and dates fail instead of changing search scope silently", () => {
    expect(() => filtersFromHistoryOptions(undefined, { limit: "nonsense" }, "/projects/shop")).toThrow();
    expect(() => filtersFromHistoryOptions(undefined, { since: "not-a-date" }, "/projects/shop")).toThrow();
});

test("history index status honors --json when history also defines --json", async () => {
    // Regression test: Terra CLI stress run — nested index status rendered a human table for Codex and Grok.
    const report: NativeIndexStatus = {
        initialized: false,
        sessions: 0,
        messages: null,
        sources: 0,
        issues: [],
    };
    const adapter: AgentSessionAdapter = {
        kind: "codex",
        list: async () => [],
        search: async () => [],
        sync: async () => ({ ...report, parsed: 0, unchanged: 0, removed: 0 }),
        status: async () => report,
    };
    const resultSpy = spyOn(out, "result").mockImplementation(() => undefined);
    const printlnSpy = spyOn(out, "println").mockImplementation(() => undefined);
    const program = new Command().name("tools-test").exitOverride();
    registerAgentHistoryCommand(program, adapter, "codex");

    await program.parseAsync(["node", "tools-test", "history", "index", "status", "--json"]);

    expect(resultSpy).toHaveBeenCalledWith(report);
    expect(printlnSpy).not.toHaveBeenCalled();
});

test("machine-readable history emits an empty JSON array when no sessions match", async () => {
    // Regression test: PR #370 review thread 8 — an empty Codex/Grok search emitted human prose.
    const adapter: AgentSessionAdapter = {
        kind: "grok",
        list: async () => [],
        search: async () => [],
    };
    const printSpy = spyOn(out, "print").mockImplementation(() => undefined);
    const printlnSpy = spyOn(out, "println").mockImplementation(() => undefined);
    const program = new Command().name("tools-test").exitOverride();
    registerAgentHistoryCommand(program, adapter, "grok");

    await program.parseAsync(["node", "tools-test", "history", "missing", "--all", "--json"]);

    expect(printSpy).toHaveBeenCalledWith("[]\n");
    expect(printlnSpy).not.toHaveBeenCalled();
});

test("--query reaches the search when the positional would hit a subcommand", async () => {
    // `history index` is claimed by the index subcommand and `--` does not rescue it, so the
    // literal word was unsearchable: the run reported index status instead of a search.
    const seen: string[] = [];
    const adapter: AgentSessionAdapter = {
        kind: "grok",
        list: async () => [],
        search: async (filters) => {
            seen.push(filters.query ?? "");
            return [];
        },
    };
    const printSpy = spyOn(out, "print").mockImplementation(() => undefined);
    const program = new Command().name("tools-test").exitOverride();
    registerAgentHistoryCommand(program, adapter, "grok");

    await program.parseAsync(["node", "tools-test", "history", "--query", "index", "--all", "--json"]);
    await program.parseAsync(["node", "tools-test", "history", "-q", "status", "--all", "--json"]);

    expect(seen).toEqual(["index", "status"]);
    printSpy.mockRestore();
});

test("an invalid filter names the problem instead of printing a stack trace", async () => {
    // `--regex 'a((('` and `--exact --regex` reached the terminal as a raw stack trace with a bun
    // version banner. The messages were already the right sentence; only the delivery was wrong.
    const adapter: AgentSessionAdapter = { kind: "grok", list: async () => [], search: async () => [] };
    const errorSpy = spyOn(out, "error").mockImplementation(() => undefined);
    const printSpy = spyOn(out, "print").mockImplementation(() => undefined);

    try {
        for (const [argv, expected] of [
            [["history", "a(((", "--regex", "--all"], /Invalid history regular expression/],
            [["history", "foo", "--exact", "--regex", "--all"], /Choose --exact or --regex/],
        ] as const) {
            const program = new Command().name("tools-test").exitOverride();
            registerAgentHistoryCommand(program, adapter, "grok");
            process.exitCode = 0;

            await program.parseAsync(["node", "tools-test", ...argv]);

            expect(errorSpy).toHaveBeenLastCalledWith(expect.stringMatching(expected));
            expect(process.exitCode).toBe(1);
        }
    } finally {
        process.exitCode = 0;
        errorSpy.mockRestore();
        printSpy.mockRestore();
    }
});
