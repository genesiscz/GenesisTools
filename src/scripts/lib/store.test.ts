import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    commitStore,
    ensureStoreScaffold,
    pathExists,
    readStoreConfig,
    runGit,
    setStoreRemote,
    storeRemoteUrl,
    writeStoreConfig,
} from "./store.ts";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "scripts-store-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

function git(args: string[]): string {
    const proc = Bun.spawnSync(["git", "-C", root, ...args]);
    return proc.stdout.toString().trim();
}

describe("store scaffold", () => {
    it("writes tsconfig, package.json and initialises a local git repo with an initial commit", async () => {
        await ensureStoreScaffold(root);

        expect(await pathExists(join(root, "tsconfig.json"))).toBe(true);
        expect(await pathExists(join(root, "package.json"))).toBe(true);
        expect(await pathExists(join(root, ".git"))).toBe(true);
        expect(await pathExists(join(root, ".gitignore"))).toBe(true);
        expect(git(["log", "--oneline"])).toContain("init script store");
        // No remote is ever configured; versioning is local-only by default.
        expect(git(["remote"])).toBe("");
    });
});

describe("commitStore", () => {
    it("commits pending changes with the given message and no-ops on a clean tree", async () => {
        await ensureStoreScaffold(root);
        await Bun.write(join(root, "persisted", "demo", "demo.ts"), "// body\n");

        await commitStore("feat: create demo", root);
        expect(git(["log", "-1", "--format=%s"])).toBe("feat: create demo");

        const head = git(["rev-parse", "HEAD"]);
        await commitStore("chore: nothing changed", root);
        expect(git(["rev-parse", "HEAD"])).toBe(head);
    });

    it("ignored paths (cache/, trash/, node_modules/) never enter history", async () => {
        await ensureStoreScaffold(root);
        await Bun.write(join(root, "cache", "registry.json"), "{}\n");
        await Bun.write(join(root, "trash", "x.ts"), "// trashed\n");

        await commitStore("chore: sweep", root);
        expect(git(["status", "--porcelain"])).toBe("");
        expect(git(["ls-files"])).not.toContain("cache/registry.json");
        expect(git(["ls-files"])).not.toContain("trash/x.ts");
    });

    it("a pre-staged file outside the allowlist is unstaged, not committed", async () => {
        await ensureStoreScaffold(root);
        await Bun.write(join(root, "secrets.env"), "TOKEN=oops\n");
        Bun.spawnSync(["git", "-C", root, "add", "secrets.env"]);

        await Bun.write(join(root, "persisted", "demo", "demo.ts"), "// body\n");
        await commitStore("feat: create demo", root);

        expect(git(["log", "-1", "--format=%s"])).toBe("feat: create demo");
        expect(git(["ls-files"])).not.toContain("secrets.env");
        expect(await Bun.file(join(root, "secrets.env")).text()).toBe("TOKEN=oops\n");
    });

    it("a stray untracked file outside the allowlist neither commits nor breaks later commits", async () => {
        await ensureStoreScaffold(root);
        await Bun.write(join(root, "stray-note.md"), "not allowlisted\n");

        const head = git(["rev-parse", "HEAD"]);
        await commitStore("chore: should be a no-op", root);
        expect(git(["rev-parse", "HEAD"])).toBe(head);

        await Bun.write(join(root, "persisted", "real", "real.ts"), "// body\n");
        await commitStore("feat: create real", root);
        expect(git(["log", "-1", "--format=%s"])).toBe("feat: create real");
        expect(git(["ls-files"])).not.toContain("stray-note.md");
    });

    it("does nothing when the store is not a git repo", async () => {
        await Bun.write(join(root, "persisted", "demo.ts"), "// body\n");
        await commitStore("feat: whatever", root);
        expect(await pathExists(join(root, ".git"))).toBe(false);
    });
});

describe("remote", () => {
    it("setStoreRemote adds origin, then updates it on a second call", async () => {
        expect(await storeRemoteUrl(root)).toBeUndefined();

        expect(await setStoreRemote("git@example.com:a/b.git", root)).toEqual({
            action: "added",
            url: "git@example.com:a/b.git",
        });
        expect(await storeRemoteUrl(root)).toBe("git@example.com:a/b.git");

        expect(await setStoreRemote("git@example.com:a/c.git", root)).toEqual({
            action: "updated",
            url: "git@example.com:a/c.git",
        });
        expect(await storeRemoteUrl(root)).toBe("git@example.com:a/c.git");
    });

    it("auto-push delivers store commits to a configured remote", async () => {
        const bare = await mkdtemp(join(tmpdir(), "scripts-remote-"));
        Bun.spawnSync(["git", "init", "--bare", "-b", "main", bare]);

        try {
            await setStoreRemote(bare, root);
            await runGit(root, ["push", "-u", "origin", "main"]);
            await writeStoreConfig({ remote: { url: bare, autoPush: true, decidedAt: "t" } }, root);

            await Bun.write(join(root, "persisted", "demo", "demo.ts"), "// body\n");
            await commitStore("feat: create demo", root);

            const remoteLog = Bun.spawnSync(["git", "-C", bare, "log", "-1", "--format=%s", "main"]);
            expect(remoteLog.stdout.toString().trim()).toBe("feat: create demo");
        } finally {
            await rm(bare, { recursive: true, force: true });
        }
    });

    it("store config round-trips decisions", async () => {
        expect(await readStoreConfig(root)).toEqual({});

        await writeStoreConfig({ remote: { declined: true, decidedAt: "t" } }, root);
        expect((await readStoreConfig(root)).remote?.declined).toBe(true);
    });
});
