import { describe, expect, test } from "bun:test";
import { commandTree } from "@app/gitlab/commands/pr";
import { buildProgram } from "@app/gitlab/commands/program";
import { rewriteArgv } from "@app/gitlab/lib/pr-argv";
import { markRequiredOptionsDeep } from "@genesiscz/utils/cli";
import type { Command } from "commander";

function leaves(cmd: Command, path: string[] = []): Array<{ cmd: Command; path: string[] }> {
    if (cmd.commands.length === 0) {
        return [{ cmd, path }];
    }

    return cmd.commands.flatMap((child) => leaves(child, [...path, child.name()]));
}

const usageOf = (cmd: Command): string => cmd.helpInformation().split("\n")[0] ?? "";

describe("the gitlab command tree", () => {
    const { program, pr } = buildProgram();
    // runTool rewrites every command's help configuration; the public usage must survive it.
    markRequiredOptionsDeep(program);
    const all = leaves(program);
    const mrLeaves = leaves(pr, ["pr"]).filter(({ cmd }) => cmd.registeredArguments[0]?.name() === "iid");

    test("the top level has only pr and activity", () => {
        expect(program.commands.map((cmd) => cmd.name()).sort()).toEqual(["activity", "pr"]);
    });

    test("every leaf prints its own usage, and an MR leaf prints the MR first", () => {
        expect(mrLeaves.length).toBeGreaterThanOrEqual(10);

        for (const { cmd, path } of all.filter((leaf) => !mrLeaves.some((mr) => mr.cmd === leaf.cmd))) {
            expect(usageOf(cmd)).toStartWith(`Usage: gitlab ${path.join(" ")}`);
        }

        for (const { cmd, path } of mrLeaves) {
            expect(usageOf(cmd)).toStartWith(`Usage: gitlab pr <iid> ${path.slice(1).join(" ")} [options]`);
        }
    });

    test("`gitlab pr <iid> <path>` reaches every MR leaf with the MR as its first argument", () => {
        const tree = commandTree(program);

        for (const { path } of mrLeaves) {
            expect(rewriteArgv(["pr", "42", ...path.slice(1), "--json"], tree)).toEqual([
                "pr",
                ...path.slice(1),
                "42",
                "--json",
            ]);
        }

        expect(rewriteArgv(["pr", "42"], tree)).toEqual(["pr", "show", "42"]);
        expect(rewriteArgv(["pr", "42", "comments"], tree)).toEqual(["pr", "comments", "list", "42"]);
        expect(rewriteArgv(["pr"], tree)).toEqual(["pr"]);
        expect(rewriteArgv(["activity", "user", "--days", "7"], tree)).toEqual([
            "activity",
            "user",
            "events",
            "--days",
            "7",
        ]);
        expect(rewriteArgv(["activity", "user", "commits", "--user", "a"], tree)).toEqual([
            "activity",
            "user",
            "commits",
            "--user",
            "a",
        ]);
        expect(rewriteArgv(["activity", "user", "--help"], tree)).toEqual(["activity", "user", "--help"]);
    });

    test("the old command names are gone", () => {
        const names = all.map(({ path }) => path.join(" "));

        for (const old of [
            "fetch-review",
            "give-review",
            "discussions",
            "draft-reply",
            "drafts",
            "batch-comment",
            "batch-label",
            "search-by-file",
            "stale-branches",
            "analyze-user",
            "analyze-project",
        ]) {
            expect(names.some((name) => name.split(" ")[0] === old)).toBe(false);
        }
    });
});
