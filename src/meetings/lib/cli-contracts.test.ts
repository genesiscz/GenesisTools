import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { registerRequestedTrees } from "@genesiscz/utils/cli/lazy-registrars";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { Command } from "commander";
import { MEETINGS_REGISTRARS } from "../registrars";
import { enumHint } from "./shared";

/**
 * What the `tools meetings` commands promise a script or the Meetings window: a refusal names a command that runs,
 * an error code leads its sentence, a JSON shape stays. Each test pins one promise.
 */
describe("enum refusals print a command that runs", () => {
    const argv = process.argv;

    afterEach(() => {
        process.argv = argv;
    });

    function typed(...args: string[]): void {
        process.argv = ["bun", "meetings", ...args];
    }

    test("a flag value keeps the subcommand and the meeting", () => {
        typed("items", "m1", "--status", "bogus");
        const hint = enumHint({
            flag: "--status",
            values: ["suggested", "confirmed"],
            subcommand: ["items"],
            given: "bogus",
        });

        expect(hint).toBe(
            '--status does not accept "bogus". Possible: suggested, confirmed\ntools meetings items m1 --status suggested'
        );
    });

    test("a two-word subcommand keeps both words", () => {
        typed("dictionary", "add", "foo", "--type", "bogus");
        const hint = enumHint({
            flag: "--type",
            values: ["fix", "abbr"],
            subcommand: ["dictionary", "add"],
            given: "bogus",
        });

        expect(hint.split("\n")[1]).toBe("tools meetings dictionary add foo --type fix");
    });

    test("a positional value is replaced in place", () => {
        typed("dictionary", "expansion", "bogus", "--project", "work");
        const hint = enumHint({
            flag: "<mode>",
            values: ["every", "first", "off"],
            subcommand: ["dictionary", "expansion"],
            given: "bogus",
        });

        expect(hint.split("\n")[1]).toBe("tools meetings dictionary expansion --project work every");
    });
});

/**
 * A command loads only its own module (startup). A registrar whose command is renamed, or an alias added without a
 * table entry, would silently fall back to loading every tree: the old 320 ms, with nothing to see.
 */
describe("MEETINGS_REGISTRARS", () => {
    test("every entry names exactly the commands its registrar adds", async () => {
        for (const entry of MEETINGS_REGISTRARS) {
            const program = new Command();
            (await entry.load())(program);
            const added = program.commands.flatMap((command) => [command.name(), ...command.aliases()]);

            expect(added.sort()).toEqual([...entry.names].sort());
        }
    });

    test("no name is claimed twice", () => {
        const names = MEETINGS_REGISTRARS.flatMap((entry) => entry.names);

        expect(names.length).toBe(new Set(names).size);
    });

    test("config registers config alone", async () => {
        const program = new Command();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "config" });

        expect(program.commands.map((command) => command.name())).toEqual(["config"]);
    });

    test("help and an unknown command register every tree, in the help order", async () => {
        const program = new Command();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: undefined });
        const registered = program.commands.flatMap((command) => [command.name(), ...command.aliases()]);

        expect(registered).toEqual(MEETINGS_REGISTRARS.flatMap((entry) => entry.names));
    });
});

/** MP3: @napi-rs/canvas loads the system fonts at import (about 100 ms), so only drawing boxes may load it. */
describe("startup imports", () => {
    test("the record and screen commands load no canvas until a box is drawn", async () => {
        const probe = [
            'const has = () => Object.keys(require.cache).some((key) => key.includes("@napi-rs/canvas"));',
            'await import("./src/meetings/commands/record.ts");',
            "const before = has();",
            'await import("@genesiscz/utils/image/render-plan");',
            "console.log(JSON.stringify({ before, after: has() }));",
        ].join("\n");
        const child = Bun.spawn(["bun", "-e", probe], {
            cwd: join(moduleDir(import.meta), "..", "..", ".."),
            stdout: "pipe",
        });
        const output = await new Response(child.stdout).text();
        await child.exited;

        expect(output.trim()).toBe(`{"before":false,"after":true}`);
    });
});
