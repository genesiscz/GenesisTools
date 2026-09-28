import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimChildFolder, claimPrivateFolder, freeDestination, moveAsideRoot, sameVolume } from "./move-aside";

// The move-aside guards on scratch folders. The whole flow (a worktree moved, re-checked, refused) is
// tested through `moveAsideWorktrees` in src/hub/lib/worktrees.test.ts.

describe("move-aside primitives", () => {
    test("the day's folder is /tmp/<YYYYMMDD>-agents-removals/<context>", () => {
        expect(moveAsideRoot({ context: "hub-worktrees", now: new Date(2026, 8, 5, 23, 59) })).toBe(
            "/tmp/20260905-agents-removals/hub-worktrees"
        );
    });

    test("a folder above the move-aside folder that other users can change refuses it; a sticky one, like /tmp, does not", () => {
        const scratch = mkdtempSync(join(tmpdir(), "gt-hub-wt-ancestor-"));
        const shared = join(scratch, "shared");
        mkdirSync(shared);
        chmodSync(shared, 0o777);
        expect(claimPrivateFolder(join(shared, "20260928-agents-removals", "hub-worktrees"))).toContain(
            `${shared} can be changed by other users`
        );

        chmodSync(shared, 0o1777);
        expect(claimPrivateFolder(join(shared, "20260929-agents-removals", "hub-worktrees"))).toBeNull();

        // A symlink on the way is followed: the real folder it leads to is held to the same rule.
        const open = join(scratch, "open");
        mkdirSync(open);
        chmodSync(open, 0o777);
        symlinkSync(open, join(scratch, "link"));
        expect(claimPrivateFolder(join(scratch, "link", "hub-worktrees"))).toContain(
            `${realpathSync(open)} can be changed by other users`
        );
    });

    test("a child folder is created 0700 inside the root; a symlink planted under its name is refused", () => {
        const root = join(mkdtempSync(join(tmpdir(), "gt-move-aside-child-")), "aside");
        expect(claimPrivateFolder(root)).toBeNull();
        expect(claimChildFolder(root, join(root, "repo"))).toBeNull();
        expect(statSync(join(root, "repo")).mode & 0o777).toBe(0o700);

        const outside = mkdtempSync(join(tmpdir(), "gt-move-aside-outside-"));
        symlinkSync(outside, join(root, "linked"));
        expect(claimChildFolder(root, join(root, "linked"))).toContain("not a plain folder inside");
    });

    test("a taken destination gets the next free -N name, and a volume check on a missing path says no", () => {
        const scratch = mkdtempSync(join(tmpdir(), "gt-move-aside-free-"));
        const base = join(scratch, "wt");
        expect(freeDestination(base)).toBe(base);

        mkdirSync(base);
        mkdirSync(`${base}-2`);
        expect(freeDestination(base)).toBe(`${base}-3`);

        expect(sameVolume(scratch, base)).toBe(true);
        expect(sameVolume(scratch, join(scratch, "missing"))).toBe(false);
    });
});
