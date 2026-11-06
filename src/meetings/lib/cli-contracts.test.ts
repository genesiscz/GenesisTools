import { afterEach, describe, expect, test } from "bun:test";
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
