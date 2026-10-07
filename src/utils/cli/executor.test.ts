/**
 * `enhanceHelp` prints a subcommand's options in its parent's help, and that block does its own
 * layout rather than going through commander's wrapper.
 *
 * It used to emit each description on a single line however long it was. `tools spotify play
 * plan --help` produced a 263-character line for `--from`, which names all five seed sources
 * inline, so the help for the flag a new user most needs was the one that wrapped worst.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { enhanceHelp } from "@genesiscz/utils/cli";
import {
    Executor,
    formatMissingEnumHelp,
    setSuggestCommandProgram,
    spawnLabel,
    suggestCommand,
    suggestEnumFlag,
} from "@genesiscz/utils/cli/executor";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
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

    /**
     * Commander appends `(default: …)` at render time from `option.defaultValue`; it is not
     * part of `option.description`. Reading only the description gave two renderers that
     * disagreed about the SAME option: the per-command help showed the default, the parent's
     * summary did not. A usability tester could not tell whether `--from` was required and
     * had to make an extra help call to find out.
     */
    test("shows option defaults, the way commander's own help does", () => {
        const program = new Command("root").exitOverride();
        program.command("child").description("a child").option("--from <source>", "where to seed from", "top");
        enhanceHelp(program);

        let captured = "";
        program.configureOutput({
            writeOut: (text) => {
                captured += text;
            },
        });
        program.outputHelp();

        expect(captured).toContain('default: "top"');
    });

    test("an option with no default gains no default text", () => {
        const program = new Command("root").exitOverride();
        program.command("child").description("a child").option("--plain <x>", "no default here");
        enhanceHelp(program);

        let captured = "";
        program.configureOutput({
            writeOut: (text) => {
                captured += text;
            },
        });
        program.outputHelp();

        expect(captured).toContain("no default here");
        expect(captured).not.toContain("default:");
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

/**
 * `suggestCommand` rebuilds a command line out of raw argv, and `--verbose fetch` has the same
 * shape as `--env test`: one flag, one bare word. It used to read every bare word after a flag
 * as that flag's value, so a boolean flag ate whatever followed it.
 *
 * `runTool` puts boolean `-v/--verbose` and `--readme` on EVERY tool, which made this reachable
 * everywhere rather than theoretical: `tools timely -v login` printed
 * `tools timely -v login login api-key`, a doubled subcommand that does not run.
 */
function programWithGlobals(): Command {
    const program = new Command("tools x");
    program.option("-v, --verbose", "boolean, like runTool's").option("--env <name>", "takes a value");
    program.command("fetch").option("--raw", "boolean").option("--session <id>", "takes a value");
    program.command("search");

    return program;
}

type Modifications = NonNullable<Parameters<typeof suggestCommand>[1]>;

function suggestWithArgv(tail: string[], modifications: Modifications): string {
    const saved = process.argv;
    process.argv = ["bun", "script", ...tail];

    try {
        return suggestCommand("tools x", modifications);
    } finally {
        process.argv = saved;
    }
}

describe("suggestCommand", () => {
    afterEach(() => {
        setSuggestCommandProgram(undefined);
    });

    test("a boolean global flag does not swallow the subcommand", () => {
        setSuggestCommandProgram(programWithGlobals());

        expect(suggestWithArgv(["--verbose", "fetch", "--env", "test"], { replaceCommand: ["search"] })).toBe(
            "tools x --verbose search"
        );
    });

    test("a value-taking global flag still carries its value over", () => {
        setSuggestCommandProgram(programWithGlobals());

        expect(suggestWithArgv(["--env", "test", "fetch"], { replaceCommand: ["search"] })).toBe(
            "tools x --env test search"
        );
    });

    test("the combined --flag=value form does not also eat the next token", () => {
        setSuggestCommandProgram(programWithGlobals());

        expect(suggestWithArgv(["--env=test", "fetch"], { replaceCommand: ["search"] })).toBe(
            "tools x --env=test search"
        );
    });

    // Commander lets only the last flag of a short cluster take a value, and `-vv` is the
    // documented way to raise verbosity twice.
    test("a short-flag cluster is judged by its last flag", () => {
        setSuggestCommandProgram(programWithGlobals());

        expect(suggestWithArgv(["-vv", "fetch"], { replaceCommand: ["search"] })).toBe("tools x -vv search");
    });

    test("`--` ends the global options, so a wrapped command is not mistaken for one", () => {
        setSuggestCommandProgram(programWithGlobals());

        expect(suggestWithArgv(["--unknown", "--", "bash", "-c", "echo hi"], { replaceCommand: ["search"] })).toBe(
            "tools x --unknown search"
        );
    });

    test("keepFlags keeps a boolean flag without the token beside it", () => {
        setSuggestCommandProgram(programWithGlobals());

        expect(
            suggestWithArgv(["fetch", "--raw", "somefile"], { replaceCommand: ["search"], keepFlags: ["--raw"] })
        ).toBe("tools x --raw search");
    });

    // `tools stash -v save mystash` used to suggest `tools stash save -v save mystash --mode
    // all`: the strip only matched at position 0, so a leading global flag hid the subcommand.
    test("the subcommand strip looks past a leading global flag", () => {
        setSuggestCommandProgram(programWithGlobals());

        expect(suggestWithArgv(["-v", "fetch", "mine"], { subcommand: ["fetch"], add: ["--raw"] })).toBe(
            "tools x -v mine --raw"
        );
    });

    test("removing a boolean flag keeps the token after it", () => {
        setSuggestCommandProgram(programWithGlobals());

        expect(suggestWithArgv(["--verbose", "fetch"], { remove: ["--verbose"] })).toBe("tools x fetch");
    });

    test("removing a value-taking flag drops its value too", () => {
        setSuggestCommandProgram(programWithGlobals());

        expect(suggestWithArgv(["--env", "test", "fetch"], { remove: ["--env"] })).toBe("tools x fetch");
    });

    test("removing the combined --flag=value form drops exactly one token", () => {
        setSuggestCommandProgram(programWithGlobals());

        expect(suggestWithArgv(["--env=test", "fetch"], { remove: ["--env"] })).toBe("tools x fetch");
    });

    // Nothing outside runTool registers a program, so the pre-existing guess has to stand there.
    test("without a registered program, a flag is still assumed to take a value", () => {
        expect(suggestWithArgv(["--verbose", "fetch"], { replaceCommand: ["search"] })).toBe(
            "tools x --verbose fetch search"
        );
    });
});

describe("formatMissingEnumHelp", () => {
    test("names every possible value and prints the suggestion on the next line", () => {
        expect(
            formatMissingEnumHelp({
                flag: "--detail",
                values: ["phases", "all"],
                suggestion: "tools config profiling --detail phases",
            })
        ).toBe("--detail requires a value. Possible: phases, all\ntools config profiling --detail phases");
    });
});

describe("suggestEnumFlag", () => {
    afterEach(() => {
        setSuggestCommandProgram(undefined);
    });

    test("replaces a bare flag with flag plus the first possible value", () => {
        const program = new Command("tools x");
        program.command("profiling").option("--scopes [list]", "names");
        setSuggestCommandProgram(program);

        const saved = process.argv;
        process.argv = ["bun", "script", "profiling", "--scopes"];

        try {
            expect(
                suggestEnumFlag("tools x profiling", "--scopes", ["claude-history", "du"], {
                    subcommand: ["profiling"],
                })
            ).toBe(
                "--scopes requires a value. Possible: claude-history, du\ntools x profiling --scopes claude-history"
            );
        } finally {
            process.argv = saved;
        }
    });
});

describe("spawnLabel", () => {
    test("names the program by its basename and keeps the first arguments", () => {
        expect(spawnLabel(["/usr/bin/git", "rev-parse", "--show-toplevel"])).toBe("git rev-parse --show-toplevel");
    });

    test("hides an argument that carries a credential", () => {
        expect(spawnLabel(["gh", "api", "-H", "Authorization: token abc123", "user"])).toBe("gh api -H *** user");
        expect(spawnLabel(["glab", "api", "--private-token=abc123"])).toBe("glab api ***");
        expect(spawnLabel(["client", "--password", "invented-credential", "go"])).toBe("client *** *** go");
        expect(spawnLabel(["C:\\tools\\gh.exe", "pr", "list"])).toBe("gh.exe pr list");
    });

    test("cuts long and many arguments", () => {
        const label = spawnLabel(["gh", "api", "graphql", "-f", `query=${"x".repeat(200)}`, "a", "b", "c"]);
        expect(label.endsWith(" …")).toBe(true);
        expect(label.length).toBeLessThan(140);
    });
});

describe("toolCommand", () => {
    // Feature: one helper names every `tools …` command in hint text, so a renamed command is found by scripts/ci/check-tool-commands.ts.
    test("joins the tool, its subcommand path and the arguments", () => {
        expect(toolCommand("macos permissions build")).toBe("tools macos permissions build");
        expect(toolCommand("notify status", "--json")).toBe("tools notify status --json");
    });

    test("quotes an argument that contains a space", () => {
        expect(toolCommand("macos permissions open", "--pane", "full disk")).toBe(
            'tools macos permissions open --pane "full disk"'
        );
    });
});

describe("Executor bounded calls", () => {
    test("a resistant child cannot extend the advertised timeout to its natural exit", async () => {
        const executor = new Executor();
        const started = performance.now();

        await expect(
            executor.exec(
                [
                    process.execPath,
                    "-e",
                    "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 1600); setInterval(() => {}, 1000);",
                ],
                { timeout: 300 }
            )
        ).rejects.toThrow("Command timed out after 300ms");

        expect(performance.now() - started).toBeLessThan(1_200);
    });

    test("a bounded normal command preserves environment and both output streams", async () => {
        const executor = new Executor({ env: { EXECUTOR_FIXTURE: "base" } });
        const result = await executor.exec(
            [
                process.execPath,
                "-e",
                "process.stdout.write(process.env.EXECUTOR_FIXTURE ?? 'missing'); process.stderr.write('diagnostic');",
            ],
            { timeout: 2_000, env: { EXECUTOR_FIXTURE: "call" } }
        );

        expect(result).toMatchObject({ success: true, exitCode: 0, stdout: "call", stderr: "diagnostic" });
    });

    test("timeout 0 still means no timeout, as it did before bounded calls", async () => {
        const result = await new Executor().exec([process.execPath, "-e", "process.stdout.write('ran')"], {
            timeout: 0,
        });

        expect(result).toMatchObject({ success: true, stdout: "ran" });
    });
});
