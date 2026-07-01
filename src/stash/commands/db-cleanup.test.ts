import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as patchModule from "../lib/patch";
import { runGitIn } from "../lib/patch";
import { saveCommand } from "./save";

let work: string;
let repo: string;
let origCwd: string;
let origStashRoot: string | undefined;
let closeCalls = 0;
let originalClose: typeof Database.prototype.close;

beforeEach(async () => {
    origCwd = process.cwd();
    work = await mkdtemp(join(tmpdir(), "stash-db-cleanup-"));
    origStashRoot = process.env.GENESIS_TOOLS_STASH_ROOT;
    process.env.GENESIS_TOOLS_STASH_ROOT = join(work, ".genesis-tools", "stash");
    repo = join(work, "repo");
    await runGitIn(work, ["init", "repo", "--initial-branch=main"]);
    await runGitIn(repo, ["config", "user.email", "t@t"]);
    await runGitIn(repo, ["config", "user.name", "t"]);
    await writeFile(join(repo, "a.ts"), "fn();\n");
    await runGitIn(repo, ["add", "a.ts"]);
    await runGitIn(repo, ["commit", "-qm", "init"]);

    closeCalls = 0;
    originalClose = Database.prototype.close;
    Database.prototype.close = function (this: Database) {
        closeCalls++;
        return originalClose.call(this);
    };
});

afterEach(async () => {
    Database.prototype.close = originalClose;
    mock.restore();
    process.chdir(origCwd);
    if (origStashRoot !== undefined) {
        process.env.GENESIS_TOOLS_STASH_ROOT = origStashRoot;
    } else {
        delete process.env.GENESIS_TOOLS_STASH_ROOT;
    }
    await rm(work, { recursive: true, force: true });
});

describe("stash command db cleanup on throw", () => {
    test("apply closes the db when applyPatch throws a non-conflict error", async () => {
        process.chdir(repo);
        await writeFile(join(repo, "a.ts"), "fn();\ninserted();\n");
        await saveCommand({ name: "cleanup-apply", mode: "all", tags: [], description: undefined });
        await runGitIn(repo, ["checkout", "a.ts"]);

        mock.module("../lib/patch", () => ({
            ...patchModule,
            applyPatch: async () => {
                throw new Error("forced apply failure");
            },
        }));

        const { applyCommand: applyWithMock } = await import("./apply");
        closeCalls = 0;

        await applyWithMock({ name: "cleanup-apply", verboseMarkers: false });

        expect(process.exitCode).toBe(1);
        expect(closeCalls).toBeGreaterThanOrEqual(1);
    });
});
