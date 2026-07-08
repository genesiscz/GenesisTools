import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { writeSetConfig } from "../lib/config";
import { readManifest } from "../lib/manifest";
import { registerAddCommand } from "./add";

async function runAdd(root: string, file: string): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerAddCommand(program);
    await program.parseAsync(["add", file, "--dir", root], { from: "user" });
}

describe("boards add", () => {
    let root: string;
    let outside: string;

    beforeEach(async () => {
        root = mkdtempSync(join(tmpdir(), "boards-add-root-"));
        outside = mkdtempSync(join(tmpdir(), "boards-add-outside-"));
        await writeSetConfig(root, { project: "p", branch: "main", key: "s1", kind: "screenshots" });
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    });

    it("treats a source already inside the root as already-placed — no -2 duplicate, single manifest entry", async () => {
        writeFileSync(join(root, "shot.png"), "AAA");
        await runAdd(root, join(root, "shot.png"));

        expect(existsSync(join(root, "shot-2.png"))).toBe(false);
        const m = await readManifest(root);
        expect(m.shots.length).toBe(1);
        expect(m.shots[0].file).toBe("shot.png");
    });

    it("re-adding the same in-root file twice stays a single manifest entry (appendShot replace)", async () => {
        writeFileSync(join(root, "shot.png"), "AAA");
        await runAdd(root, join(root, "shot.png"));
        await runAdd(root, join(root, "shot.png"));

        expect(existsSync(join(root, "shot-2.png"))).toBe(false);
        expect(existsSync(join(root, "shot-3.png"))).toBe(false);
        const m = await readManifest(root);
        expect(m.shots.length).toBe(1);
        expect(m.shots[0].file).toBe("shot.png");
    });

    it("an OUTSIDE file colliding with a different in-root file still suffixes to -2", async () => {
        writeFileSync(join(root, "shot.png"), "A"); // pre-existing, different content
        writeFileSync(join(outside, "shot.png"), "B");
        await runAdd(root, join(outside, "shot.png"));

        expect(existsSync(join(root, "shot-2.png"))).toBe(true);
        const m = await readManifest(root);
        expect(m.shots.some((s) => s.file === "shot-2.png")).toBe(true);
    });
});
