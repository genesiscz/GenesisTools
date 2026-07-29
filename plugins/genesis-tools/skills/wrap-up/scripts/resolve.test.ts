import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    blockquote,
    buildLogBody,
    derivedDocPath,
    type Entry,
    expandHome,
    innerBlock,
    matches,
    parseFlags,
    sh,
    slug,
    splitSentinels,
    writeAtomic,
} from "./resolve.ts";

const HERE_START = "<!-- YOU-ARE-HERE:START -->";
const HERE_END = "<!-- YOU-ARE-HERE:END -->";

function docWith(headerBody: string, tail = "\n\n---\n\n## 2026-07-01 10:00 — first session\n\nseed body.\n"): string {
    return `# Wrap-up: Demo\n\n${HERE_START}\n## You are here (2026-07-01 10:00)\n${headerBody}\n${HERE_END}${tail}`;
}

describe("slug", () => {
    it("lowercases and dashes a branch name", () => {
        expect(slug("feat/Skills-Handoff")).toBe("feat-skills-handoff");
    });

    it("trims leading and trailing separators", () => {
        expect(slug("///feat///")).toBe("feat");
    });

    it("falls back to 'main' when nothing survives", () => {
        expect(slug("")).toBe("main");
        expect(slug("///")).toBe("main");
    });
});

describe("derivedDocPath", () => {
    const entry: Entry = { projectDir: "/repos/MyProject", obsidianDir: "/vault/MyProject" };

    it("derives <obsidianDir>/<project>-<branch-slug>.wrapup.md", () => {
        expect(derivedDocPath(entry, "feat/x")).toBe("/vault/MyProject/MyProject-feat-x.wrapup.md");
    });

    it("gives each branch its own file", () => {
        expect(derivedDocPath(entry, "feat/a")).not.toBe(derivedDocPath(entry, "feat/b"));
    });

    it("prefers an explicit docPath over the derived one", () => {
        const pinned: Entry = { ...entry, docPath: "/vault/pinned.md" };
        expect(derivedDocPath(pinned, "feat/x")).toBe("/vault/pinned.md");
    });
});

describe("matches", () => {
    const ctx = { toplevel: "/repos/Proj", branch: "feat/x", cwd: "/repos/Proj" };

    it("returns 0 when the path does not match at all", () => {
        expect(matches({ projectDir: "/repos/Other", obsidianDir: "/v" }, ctx)).toBe(0);
    });

    it("matches any branch when the entry declares none", () => {
        expect(matches({ projectDir: "/repos/Proj", obsidianDir: "/v" }, ctx)).toBe(1);
    });

    it("returns 0 when the entry pins a different branch", () => {
        expect(matches({ projectDir: "/repos/Proj", obsidianDir: "/v", branch: "feat/other" }, ctx)).toBe(0);
    });

    it("scores a branch-pinned entry above a project-wide one", () => {
        const wide = matches({ projectDir: "/repos/Proj", obsidianDir: "/v" }, ctx);
        const pinned = matches({ projectDir: "/repos/Proj", obsidianDir: "/v", branch: "feat/x" }, ctx);
        expect(pinned).toBeGreaterThan(wide);
    });

    it("scores a worktree match highest", () => {
        const wt = { toplevel: "/repos/Proj/.worktrees/x", branch: "feat/x", cwd: "/repos/Proj/.worktrees/x" };
        const pinned = matches({ projectDir: "/repos/Proj", obsidianDir: "/v", branch: "feat/x" }, wt);
        const worktree = matches(
            {
                projectDir: "/repos/Proj",
                obsidianDir: "/v",
                branch: "feat/x",
                worktreeDir: "/repos/Proj/.worktrees/x",
            },
            wt
        );
        expect(worktree).toBeGreaterThan(pinned);
    });

    it("matches a cwd nested under the project dir", () => {
        const nested = { toplevel: "/repos/Proj", branch: "feat/x", cwd: "/repos/Proj/src/deep" };
        expect(matches({ projectDir: "/repos/Proj", obsidianDir: "/v" }, nested)).toBe(1);
    });

    it("does not match a sibling dir sharing a name prefix", () => {
        const sibling = { toplevel: "/repos/ProjOther", branch: "feat/x", cwd: "/repos/ProjOther" };
        expect(matches({ projectDir: "/repos/Proj", obsidianDir: "/v" }, sibling)).toBe(0);
    });
});

describe("splitSentinels", () => {
    it("splits a well-formed payload", () => {
        const res = splitSentinels("@@HERE@@\n- state\n@@LOG@@\n## topic\nbody");
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.hereBody).toBe("- state");
            expect(res.logBody).toBe("## topic\nbody");
        }
    });

    it("rejects empty stdin", () => {
        const res = splitSentinels("   \n  ");
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.problem).toContain("nothing on stdin");
        }
    });

    it("names both missing sentinels", () => {
        const res = splitSentinels("just some prose");
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.problem).toContain("@@HERE@@");
            expect(res.problem).toContain("@@LOG@@");
        }
    });

    it("names the single missing sentinel", () => {
        const res = splitSentinels("@@HERE@@\n- state");
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.problem).toContain("@@LOG@@");
            expect(res.problem).not.toContain("@@HERE@@ and");
        }
    });

    it("rejects reversed sentinel order", () => {
        const res = splitSentinels("@@LOG@@\nbody\n@@HERE@@\n- state");
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.problem).toContain("order must be");
        }
    });

    it("rejects an empty @@HERE@@ section", () => {
        const res = splitSentinels("@@HERE@@\n@@LOG@@\n## topic");
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.problem).toContain("@@HERE@@ section is empty");
        }
    });

    it("rejects an empty @@LOG@@ section", () => {
        const res = splitSentinels("@@HERE@@\n- state\n@@LOG@@\n");
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.problem).toContain("@@LOG@@ section is empty");
        }
    });
});

describe("buildLogBody", () => {
    const args = { hereBody: "- **State:** new", logBody: "## 2026-07-29 06:47 — second", stamp: "2026-07-29 06:47" };

    it("rewrites the header in place with the new stamp", () => {
        const res = buildLogBody({ text: docWith("- **State:** old"), ...args });
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.body).toContain("## You are here (2026-07-29 06:47)");
            expect(res.body).toContain("- **State:** new");
            // The old stamp survives only as a quoted line in the snapshot,
            // never as a live header.
            expect(res.body).not.toContain("\n## You are here (2026-07-01 10:00)");
            expect(res.body).toContain("\n> ## You are here (2026-07-01 10:00)");
        }
    });

    it("keeps exactly one YOU-ARE-HERE block", () => {
        const res = buildLogBody({ text: docWith("- **State:** old"), ...args });
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.body.split(HERE_START).length - 1).toBe(1);
            expect(res.body.split(HERE_END).length - 1).toBe(1);
        }
    });

    it("preserves earlier log sections (append-only audit trail)", () => {
        const res = buildLogBody({ text: docWith("- **State:** old"), ...args });
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.body).toContain("## 2026-07-01 10:00 — first session");
            expect(res.body).toContain("seed body.");
            expect(res.body.indexOf("first session")).toBeLessThan(res.body.indexOf("second"));
        }
    });

    it("appends the before/after snapshot quoting the old and new state", () => {
        const res = buildLogBody({ text: docWith("- **State:** old"), ...args });
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.body).toContain("### Header before → after");
            expect(res.body).toContain("> - **State:** old");
            expect(res.body).toContain("> - **State:** new");
        }
    });

    it("is idempotent in shape — logging twice keeps one header and both sections", () => {
        const first = buildLogBody({ text: docWith("- **State:** old"), ...args });
        expect(first.ok).toBe(true);
        if (!first.ok) {
            return;
        }

        const second = buildLogBody({
            text: first.body,
            hereBody: "- **State:** third",
            logBody: "## 2026-07-29 07:00 — third",
            stamp: "2026-07-29 07:00",
        });
        expect(second.ok).toBe(true);
        if (second.ok) {
            expect(second.body.split(HERE_START).length - 1).toBe(1);
            expect(second.body).toContain("## 2026-07-01 10:00 — first session");
            expect(second.body).toContain("— second");
            expect(second.body).toContain("— third");
        }
    });

    it("reports a file with no YOU-ARE-HERE block", () => {
        const res = buildLogBody({ text: "# Just a heading\n\nno block here.\n", ...args });
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.problem).toContain("no valid");
        }
    });

    it("reports a block whose markers are inverted", () => {
        const res = buildLogBody({ text: `# Doc\n${HERE_END}\nbody\n${HERE_START}\n`, ...args });
        expect(res.ok).toBe(false);
    });
});

describe("blockquote / innerBlock", () => {
    it("quotes every line and keeps blank lines as bare '>'", () => {
        expect(blockquote("a\n\nb")).toBe("> a\n>\n> b");
    });

    it("strips the sentinel markers", () => {
        expect(innerBlock(`${HERE_START}\n## You are here\n- x\n${HERE_END}`)).toBe("## You are here\n- x");
    });
});

describe("parseFlags", () => {
    it("pairs each --flag with its value", () => {
        expect(parseFlags(["--obsidian", "/vault", "--branch", "feat/x"])).toEqual({
            obsidian: "/vault",
            branch: "feat/x",
        });
    });

    it("gives a trailing valueless flag an empty string", () => {
        expect(parseFlags(["--doc"])).toEqual({ doc: "" });
    });

    it("ignores positional noise", () => {
        expect(parseFlags(["stray", "--branch", "feat/x"])).toEqual({ branch: "feat/x" });
    });
});

describe("writeAtomic", () => {
    const fixtures: string[] = [];

    async function tempDir(): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), "wrapup-atomic-"));
        fixtures.push(dir);
        return dir;
    }

    afterEach(async () => {
        await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it("replaces the destination's contents", async () => {
        const dir = await tempDir();
        const target = join(dir, "doc.md");
        await writeFile(target, "old contents");

        await writeAtomic(target, "new contents");
        expect(await Bun.file(target).text()).toBe("new contents");
    });

    it("creates the file when it does not exist yet", async () => {
        const dir = await tempDir();
        const target = join(dir, "fresh.md");

        await writeAtomic(target, "hello");
        expect(await Bun.file(target).text()).toBe("hello");
    });

    it("preserves a restrictive destination mode instead of widening it", async () => {
        const dir = await tempDir();
        const target = join(dir, "private.json");
        await writeFile(target, "{}");
        await chmod(target, 0o600);

        await writeAtomic(target, '{"entries":[]}');
        // rename() installs a new inode; without carrying the mode over this
        // would come back as the umask default (commonly 0644).
        expect((await stat(target)).mode & 0o777).toBe(0o600);
    });

    it("leaves no temp file behind", async () => {
        const dir = await tempDir();
        const target = join(dir, "doc.md");

        await writeAtomic(target, "body");
        expect((await readdir(dir)).filter((f) => f.includes(".tmp-"))).toEqual([]);
    });

    it("cleans up the temp file when the rename fails", async () => {
        const dir = await tempDir();
        // rename() onto a NON-EMPTY directory fails, which is what drives the
        // cleanup path after the temp file has already been written. Create the
        // directory explicitly rather than leaning on Bun.write's implicit
        // parent creation, so the setup states its own intent.
        const target = join(dir, "adir");
        await mkdir(target);
        await writeFile(join(target, "keep.txt"), "x");

        await expect(writeAtomic(target, "body")).rejects.toThrow();
        expect((await readdir(dir)).filter((f) => f.includes(".tmp-"))).toEqual([]);
        // The destination is untouched, which pins that the rejection came from
        // the rename onto the directory and not from something incidental.
        expect(await readdir(target)).toEqual(["keep.txt"]);
    });
});

describe("sh", () => {
    it("returns trimmed stdout on success", async () => {
        expect(await sh(["echo", "  hello  "])).toBe("hello");
    });

    it("returns empty string when the command exits non-zero", async () => {
        expect(await sh(["false"])).toBe("");
    });

    it("discards stdout when the command exits non-zero", async () => {
        // `false` prints nothing, so it cannot tell whether stdout is being
        // dropped or was simply empty. A failing command that DOES print is
        // the case that matters: git can write to stdout and still fail, and
        // passing that through would be read as a real toplevel or branch.
        expect(await sh(["sh", "-c", "echo not-a-real-branch; exit 3"])).toBe("");
    });

    it("returns empty string instead of throwing when the binary is missing", async () => {
        // Bun.spawn throws on ENOENT; gitContext()'s documented no-git fallback
        // depends on this degrading to "" rather than crashing the command.
        expect(await sh(["wrap-up-no-such-binary-xyz"])).toBe("");
    });
});

describe("expandHome", () => {
    it("leaves absolute and relative paths untouched", () => {
        expect(expandHome("/abs/path")).toBe("/abs/path");
        expect(expandHome(".claude/wrapups")).toBe(".claude/wrapups");
    });

    it("expands a leading ~/", () => {
        expect(expandHome("~/vault")).not.toContain("~");
        expect(expandHome("~/vault").endsWith("/vault")).toBe(true);
    });
});
