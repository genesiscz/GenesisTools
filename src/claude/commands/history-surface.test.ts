import { expect, test } from "bun:test";
import { Command } from "commander";
import { registerHistoryCommand } from "./history";

/**
 * Characterization: what `tools claude history` accepts, pinned BEFORE it was converted onto
 * `registerAgentHistoryCommand`.
 *
 * Claude's door was a second ~560-line implementation of the shared command, so the conversion
 * could silently drop a flag nobody would miss until they typed it. This is the list as it
 * stood; the conversion may ADD to it and may not take anything away.
 */

const FLAGS = [
    "--agents-only",
    "--all",
    "--commit",
    "--commit-msg",
    "--context",
    "--conv-date",
    "--conv-date-until",
    "--exact",
    "--exclude-agents",
    "--exclude-current",
    "--exclude-session",
    "--exclude-thinking",
    "--file",
    "--files",
    "--format",
    "--interactive",
    "--json",
    "--limit",
    "--list-summaries",
    "--project",
    "--query",
    "--regex",
    "--since",
    "--sort-relevance",
    "--summary-only",
    "--tool",
    "--until",
];

/** A short is muscle memory; losing one is as breaking as losing the flag. */
const SHORTS = ["-c", "-f", "-i", "-l", "-p", "-q", "-t"];

function historyCommand(): Command {
    const program = new Command();
    registerHistoryCommand(program);
    const history = program.commands.find((command) => command.name() === "history");

    if (!history) {
        throw new Error("tools claude history is not registered");
    }

    return history;
}

test("every flag the Claude history door accepted is still accepted", () => {
    const history = historyCommand();
    const long = new Set(history.options.map((option) => option.long));

    expect([...FLAGS].filter((flag) => !long.has(flag))).toEqual([]);
});

test("the short forms survive", () => {
    const history = historyCommand();
    const shorts = new Set(history.options.map((option) => option.short));

    expect([...SHORTS].filter((short) => !shorts.has(short))).toEqual([]);
});

test("the query positional and the three subcommands survive", () => {
    const history = historyCommand();

    expect(history.registeredArguments.map((argument) => argument.name())).toEqual(["query"]);
    // `index` is shared; `extract-shell-quirks` and `dashboard` are Claude's own and must
    // outlive the conversion.
    expect(history.commands.map((command) => command.name()).sort()).toEqual([
        "dashboard",
        "extract-shell-quirks",
        "index",
    ]);
});

test("--format still takes a value, and the repeatable flags still repeat", () => {
    const history = historyCommand();
    const option = (long: string) => history.options.find((candidate) => candidate.long === long);

    expect(option("--format")?.required || option("--format")?.optional).toBe(true);

    // Repeatable flags carry a reducer; without one the second `-f` overwrites the first.
    for (const long of ["--file", "--files"]) {
        expect(typeof option(long)?.parseArg).toBe("function");
    }

    // ❗ Gained by the conversion. This door declared `--exclude-session <id>` with no reducer,
    // so a second one overwrote the first and only the last session was excluded. The shared
    // command collects it, and now so does this one.
    expect(typeof option("--exclude-session")?.parseArg).toBe("function");
});

test("the conversion added --cwd, which this door never had", () => {
    const history = historyCommand();

    expect(history.options.map((option) => option.long)).toContain("--cwd");
});
