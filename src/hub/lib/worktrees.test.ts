import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWorktrees as sharedScan } from "@genesiscz/utils/git";
import { Command, CommanderError } from "commander";
import { scanWorktrees, worktreeSizes } from "./worktrees";
import { registerWorktreesCommand } from "./worktrees-command";

test("the disk-reclaim import exposes the shared scanner", () => {
    expect(scanWorktrees).toBe(sharedScan);
});

describe("the CLI and size doors", () => {
    test("--live-minutes abc is a commander usage error, not a stack trace", async () => {
        const program = new Command().exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
        registerWorktreesCommand(program);
        const error = await program
            .parseAsync(["worktrees", "list", "--live-minutes", "abc"], { from: "user" })
            .catch((err: unknown) => err);
        expect(error).toBeInstanceOf(CommanderError);
        expect(error).toMatchObject({ code: "commander.invalidArgument" });
    });

    test("size of a folder that does not exist is an error, not a measured 0 bytes", async () => {
        const missing = join(mkdtempSync(join(tmpdir(), "gt-hub-wt-size-")), "gone");
        const [size] = await worktreeSizes([missing]);
        expect(size?.error).toBe("The folder does not exist");
        expect(size?.freeableBytes).toBeNull();
    });
});
