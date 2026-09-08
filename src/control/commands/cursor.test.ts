import { expect, test } from "bun:test";
import { Command } from "commander";
import { registerCursorCommands } from "./cursor";

test("cursor commands expose move show and window addressed click options", () => {
    const program = new Command();
    program.exitOverride();
    registerCursorCommands(program);

    const cursor = program.commands.find((command) => command.name() === "cursor");
    expect(cursor).toBeDefined();
    expect(cursor?.commands.map((command) => command.name())).toEqual(["move", "show", "click"]);

    const move = cursor?.commands.find((command) => command.name() === "move");
    expect(move?.options.filter((option) => option.mandatory).map((option) => option.long)).toEqual([
        "--app",
        "--snapshot",
        "--coords",
    ]);
    expect(move?.options.find((option) => option.long === "--name")?.defaultValue).toBe("default");

    const click = cursor?.commands.find((command) => command.name() === "click");
    expect(click?.options.map((option) => option.long)).toEqual(["--name", "--snapshot", "--button", "--double"]);
});
