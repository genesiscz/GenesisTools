import { describe, expect, test } from "bun:test";
import { prCommandTree } from "@app/gitlab/commands/pr";
import { buildProgram } from "@app/gitlab/commands/program";
import { rewritePrArgv } from "@app/gitlab/lib/pr-argv";
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

    test("the top level has only pr, user and project", () => {
        expect(program.commands.map((cmd) => cmd.name()).sort()).toEqual(["pr", "project", "user"]);
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
        const tree = prCommandTree(pr);

        for (const { path } of mrLeaves) {
            expect(rewritePrArgv(["pr", "42", ...path.slice(1), "--json"], tree)).toEqual([
                "pr",
                ...path.slice(1),
                "42",
                "--json",
            ]);
        }

        expect(rewritePrArgv(["pr", "42"], tree)).toEqual(["pr", "show", "42"]);
        expect(rewritePrArgv(["pr", "42", "comments"], tree)).toEqual(["pr", "comments", "list", "42"]);
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
