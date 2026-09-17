/**
 * The command tree, read IN THIS PROCESS.
 *
 * This used to shell out to `bun src/ai-spend/index.ts <args> --help`, once for the root, once
 * per source and once for `statusline` — 18 cold bun starts for a single test, measured at
 * 2.82 s on CI and the worst per-test cost in the whole suite. Commander already holds the
 * answer in memory: `helpInformation()` renders exactly the text `--help` prints, so building
 * the same program the entrypoint builds asks the same question with no process at all.
 *
 * Same precedent as `src/spotify/tests/cli.test.ts`, which took 75 spawns down to zero.
 */
import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { registerSpendCommand } from "../register";
import { SOURCE_IDS, SOURCE_REPORTS } from "./types";

function program(): Command {
    const root = new Command();

    // Mirrors src/ai-spend/index.ts. Only the command TREE is under test here, so the two are
    // allowed to drift on name and description without this test caring.
    root.name("ai-spend").description("Coding-agent token and cost analytics");
    registerSpendCommand(root);

    return root;
}

function help(root: Command, path: string[]): string {
    let node = root;

    for (const name of path) {
        const child: Command | undefined = node.commands.find((candidate) => candidate.name() === name);
        expect(child, `no \`${name}\` command under \`${node.name()}\``).toBeDefined();
        node = child as Command;
    }

    return node.helpInformation();
}

describe("ai-spend command tree", () => {
    it("lists every ccusage command path from the live inventory", () => {
        const root = program();
        const rootHelp = help(root, []);

        for (const name of [
            "daily",
            "weekly",
            "monthly",
            "session",
            "blocks",
            "statusline",
            "summary",
            "sessions",
            "today",
            "monitor",
            ...SOURCE_IDS,
        ]) {
            expect(rootHelp).toContain(name);
        }

        for (const source of SOURCE_IDS) {
            const sourceHelp = help(root, [source]);

            for (const kind of SOURCE_REPORTS[source]) {
                expect(sourceHelp).toContain(kind);
            }
        }

        const statusline = help(root, ["statusline"]);
        expect(statusline).toContain("--visual-burn-rate");
        expect(statusline).toContain("--timezone");
    });
});
