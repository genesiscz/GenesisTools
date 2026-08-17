/**
 * `enhanceHelp` prints a subcommand's options in its parent's help, and that block does its own
 * layout rather than going through commander's wrapper.
 *
 * It used to emit each description on a single line however long it was. `tools spotify play
 * plan --help` produced a 263-character line for `--from`, which names all five seed sources
 * inline, so the help for the flag a new user most needs was the one that wrapped worst.
 */
import { describe, expect, test } from "bun:test";
import { enhanceHelp } from "@genesiscz/utils/cli";
import { Command } from "commander";

const LONG =
    "which tracks to seed — top: most played songs; gems: played often, barely streamed by " +
    "anyone else; forgotten: loved once, silent for months; unplayed: liked but never actually " +
    "played; recent: most recently added to the library";

/**
 * `helpInformation()` deliberately excludes `addHelpText` hooks, and the block under test IS
 * such a hook, so the help has to be captured the way a user receives it: through the writer.
 */
function helpWithSubcommandOptions(): string {
    const program = new Command("root").exitOverride();
    program.command("child").description("a child").option("--from <source>", LONG).option("--short <n>", "brief");
    enhanceHelp(program);

    let captured = "";
    program.configureOutput({
        writeOut: (text) => {
            captured += text;
        },
    });
    program.outputHelp();

    return captured;
}

describe("enhanceHelp subcommand options", () => {
    test("lists the subcommand's options in the parent help", () => {
        const help = helpWithSubcommandOptions();

        expect(help).toContain("Subcommand Options");
        expect(help).toContain("--from <source>");
        expect(help).toContain("--short <n>");
    });

    test("wraps a long description instead of emitting one enormous line", () => {
        const longest = Math.max(
            ...helpWithSubcommandOptions()
                .split("\n")
                .map((l) => l.length)
        );

        // The description alone is over 230 characters, so an unwrapped line is unmistakable.
        expect(longest).toBeLessThanOrEqual(120);
    });

    test("keeps the whole description, only broken across lines", () => {
        const help = helpWithSubcommandOptions();
        // Collapse the layout back down: every word must have survived the wrap.
        const flat = help.replace(/\s+/g, " ");

        for (const phrase of ["most played songs", "silent for months", "most recently added to the library"]) {
            expect(flat).toContain(phrase);
        }
    });

    test("indents continuation lines past the flag column", () => {
        const lines = helpWithSubcommandOptions().split("\n");
        const start = lines.findIndex((l) => l.includes("--from <source>"));

        expect(start).toBeGreaterThan(-1);

        // The line after the flag is a continuation of the same description, so it must be
        // blank in the flag column rather than starting where a new flag would.
        const continuation = lines[start + 1]!;
        expect(continuation).toMatch(/^\s{20,}\S/);
        expect(continuation).not.toContain("--");
    });
});
