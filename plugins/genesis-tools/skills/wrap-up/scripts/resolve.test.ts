import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry as loadRegistryFile, saveRegistry as saveRegistryFile } from "../../../lib/vault-registry.ts";
import {
    ambientBranchWarnings,
    auditRegistry,
    blockquote,
    buildLogBody,
    derivedDocPath,
    type Entry,
    entryBranch,
    expandHome,
    innerBlock,
    matches,
    nextSteps,
    parseFlags,
    parsePorcelainMain,
    parsePorcelainWorktrees,
    rankEntries,
    resolutionWarnings,
    resolveDocPath,
    sh,
    siblingWarning,
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

    it("does not match a nested git checkout under a parent projectDir", () => {
        const nestedGit = {
            toplevel: "/repos/parent/child",
            branch: "main",
            cwd: "/repos/parent/child",
        };
        expect(matches({ projectDir: "/repos/parent", obsidianDir: "/v" }, nestedGit)).toBe(0);
    });
});

describe("matches — linked worktrees", () => {
    const sibling = {
        toplevel: "/repos/Proj-wt-feature",
        branch: "feat/x",
        cwd: "/repos/Proj-wt-feature",
        mainProject: "/repos/Proj",
    };

    it("matches an entry registered against the main checkout", () => {
        expect(matches({ projectDir: "/repos/Proj", obsidianDir: "/v", branch: "feat/x" }, sibling)).toBeGreaterThan(0);
    });

    it("still respects the entry's branch pin from a worktree", () => {
        expect(matches({ projectDir: "/repos/Proj", obsidianDir: "/v", branch: "feat/other" }, sibling)).toBe(0);
    });

    it("ranks the worktree-specific entry above the main-checkout one", () => {
        const viaMain = matches({ projectDir: "/repos/Proj", obsidianDir: "/v", branch: "feat/x" }, sibling);
        const viaWorktree = matches(
            {
                projectDir: "/repos/Proj",
                obsidianDir: "/v",
                branch: "feat/x",
                worktreeDir: "/repos/Proj-wt-feature",
            },
            sibling
        );
        expect(viaWorktree).toBeGreaterThan(viaMain);
    });

    it("does not match another project just because we are in a worktree", () => {
        expect(matches({ projectDir: "/repos/Other", obsidianDir: "/v" }, sibling)).toBe(0);
    });

    it("never applies a worktree-pinned entry outside that worktree", () => {
        const pinnedToY = { projectDir: "/repos/Proj", obsidianDir: "/v", worktreeDir: "/repos/Proj-wt-y" };
        const main = { toplevel: "/repos/Proj", branch: "feat/x", cwd: "/repos/Proj" };

        expect(matches(pinnedToY, main)).toBe(0);
        expect(matches(pinnedToY, sibling)).toBe(0);
        expect(matches(pinnedToY, { ...sibling, toplevel: "/repos/Proj-wt-y", cwd: "/repos/Proj-wt-y/src" })).toBe(3);
    });
});

describe("an unreadable registry", () => {
    const dirs: string[] = [];

    afterEach(async () => {
        for (const dir of dirs.splice(0)) {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("reads as no entries, and is never overwritten by a save", async () => {
        const dir = await mkdtemp(join(tmpdir(), "gt-registry-"));
        const path = join(dir, "vault-registry.json");

        dirs.push(dir);
        await writeFile(path, "{ not json");

        const loaded = await loadRegistryFile(path, "test");

        expect(loaded.entries).toEqual([]);

        loaded.entries.push({ projectDir: "/repos/Proj", obsidianDir: "/v" });

        await expect(saveRegistryFile(path, loaded)).rejects.toThrow("refusing to overwrite");
        expect(await Bun.file(path).text()).toBe("{ not json");
    });

    it("still saves a registry that was read cleanly", async () => {
        const dir = await mkdtemp(join(tmpdir(), "gt-registry-"));
        const path = join(dir, "vault-registry.json");

        dirs.push(dir);
        await writeFile(path, JSON.stringify({ entries: [] }));

        const loaded = await loadRegistryFile(path, "test");

        loaded.entries.push({ projectDir: "/repos/Proj", obsidianDir: "/v" });
        await saveRegistryFile(path, loaded);

        expect((await loadRegistryFile(path, "test")).entries).toHaveLength(1);
    });
});

describe("nextSteps", () => {
    const cmds = { registerCmd: "REGISTER", entriesCmd: "ENTRIES" };

    it("walks Tier 1 → entries → confirm → register when nothing resolved", () => {
        const steps = nextSteps({ found: false, exact: false, docExists: false, docPath: "", ...cmds });
        expect(steps[0]).toContain("Tier 1");
        expect(steps.some((s) => s.includes("ENTRIES"))).toBe(true);
        expect(steps.some((s) => s.includes("REGISTER"))).toBe(true);
    });

    it("blocks writing and offers the pin command on a non-exact match", () => {
        const steps = nextSteps({ found: true, exact: false, docExists: true, docPath: "/v/d.md", ...cmds });
        expect(steps[0]).toContain("Do not write yet");
        expect(steps[1]).toContain("REGISTER");
    });

    it("goes straight to here/log on an exact match with an existing doc", () => {
        const steps = nextSteps({ found: true, exact: true, docExists: true, docPath: "/v/d.md", ...cmds });
        expect(steps).toHaveLength(1);
        expect(steps[0]).toContain("here");
        expect(steps[0]).toContain("log");
    });

    it("says to create the file first when the doc is missing", () => {
        const steps = nextSteps({ found: true, exact: true, docExists: false, docPath: "/v/d.md", ...cmds });
        expect(steps[0]).toContain("template");
    });
});

describe("auditRegistry", () => {
    const allPresent = () => true;

    it("reports a branch-less entry as a catch-all", () => {
        const issues = auditRegistry([{ projectDir: "/repos/Proj", obsidianDir: "/v" }], allPresent);
        expect(issues.map((i) => i.kind)).toEqual(["catch-all"]);
    });

    it("reports a catch-all with a pinned docPath as sharing one file", () => {
        const issues = auditRegistry(
            [{ projectDir: "/repos/Proj", obsidianDir: "/v", docPath: "/v/one.md" }],
            allPresent
        );
        expect(issues.map((i) => i.kind)).toEqual(["catch-all", "shared-doc"]);
    });

    it("stays silent on a healthy branch-pinned entry", () => {
        const issues = auditRegistry([{ projectDir: "/repos/Proj", obsidianDir: "/v", branch: "feat/x" }], allPresent);
        expect(issues).toEqual([]);
    });

    it("reports deleted project, worktree and vault directories", () => {
        const entry: Entry = {
            projectDir: "/gone/Proj",
            obsidianDir: "/gone/vault",
            branch: "feat/x",
            worktreeDir: "/gone/wt",
        };
        const issues = auditRegistry([entry], () => false);
        expect(issues.map((i) => i.kind).sort()).toEqual(["missing-project", "missing-vault-dir", "missing-worktree"]);
    });

    it("carries a fix command on every issue", () => {
        const issues = auditRegistry([{ projectDir: "/repos/Proj", obsidianDir: "/v" }], allPresent);
        expect(issues.every((i) => i.fix.length > 0)).toBe(true);
    });
});

describe("rankEntries", () => {
    const ctx = { toplevel: "/repos/Proj", branch: "feat/x", cwd: "/repos/Proj" };

    it("puts the branch-pinned entry above the project-wide one", () => {
        const wide: Entry = { projectDir: "/repos/Proj", obsidianDir: "/v/wide" };
        const pinned: Entry = { projectDir: "/repos/Proj", obsidianDir: "/v/pinned", branch: "feat/x" };
        expect(rankEntries([wide, pinned], ctx)[0].entry.obsidianDir).toBe("/v/pinned");
    });

    it("breaks an equal-specificity tie with the newest registration", () => {
        const old: Entry = { projectDir: "/repos/Proj", obsidianDir: "/v/old" };
        const recent: Entry = { projectDir: "/repos/Proj", obsidianDir: "/v/recent" };
        expect(rankEntries([old, recent], ctx)[0].entry.obsidianDir).toBe("/v/recent");
    });

    it("drops entries for other projects and other branches", () => {
        const foreign: Entry = { projectDir: "/repos/Other", obsidianDir: "/v/foreign" };
        const otherBranch: Entry = { projectDir: "/repos/Proj", obsidianDir: "/v/other", branch: "feat/y" };
        const mine: Entry = { projectDir: "/repos/Proj", obsidianDir: "/v/mine", branch: "feat/x" };
        expect(rankEntries([foreign, otherBranch, mine], ctx).map((r) => r.entry.obsidianDir)).toEqual(["/v/mine"]);
    });
});

describe("resolutionWarnings", () => {
    const ctx = { toplevel: "/repos/Proj", branch: "feat/x", cwd: "/repos/Proj" };

    it("flags a project-wide entry as claiming every branch", () => {
        const warnings = resolutionWarnings({
            entry: { projectDir: "/repos/Proj", obsidianDir: "/v" },
            ctx,
            alternatives: [],
            docExists: true,
        });
        expect(warnings.some((w) => w.includes("project-wide entry"))).toBe(true);
    });

    it("flags a project-wide entry that also pins a shared docPath", () => {
        const warnings = resolutionWarnings({
            entry: { projectDir: "/repos/Proj", obsidianDir: "/v", docPath: "/v/one.md" },
            ctx,
            alternatives: [],
            docExists: true,
        });
        expect(warnings.some((w) => w.includes("same file"))).toBe(true);
    });

    it("stays silent for a branch-exact match whose doc exists", () => {
        const warnings = resolutionWarnings({
            entry: { projectDir: "/repos/Proj", obsidianDir: "/v", branch: "feat/x" },
            ctx,
            alternatives: [],
            docExists: true,
        });
        expect(warnings).toEqual([]);
    });

    it("counts the other matching entries and the missing doc", () => {
        const warnings = resolutionWarnings({
            entry: { projectDir: "/repos/Proj", obsidianDir: "/v", branch: "feat/x" },
            ctx,
            alternatives: [{ entry: { projectDir: "/repos/Proj", obsidianDir: "/v2" }, score: 1 }],
            docExists: false,
        });
        expect(warnings.some((w) => w.includes("1 other registry entry"))).toBe(true);
        expect(warnings.some((w) => w.includes("does not exist yet"))).toBe(true);
    });
});

describe("entryBranch", () => {
    it("pins the current branch when none is given", () => {
        expect(entryBranch({ obsidian: "/v" }, "feat/x")).toBe("feat/x");
    });

    it("keeps an explicit branch", () => {
        expect(entryBranch({ branch: "feat/y" }, "feat/x")).toBe("feat/y");
    });

    it("makes a catch-all only when --all-branches is passed", () => {
        expect(entryBranch({ "all-branches": "" }, "feat/x")).toBe("");
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

    it("reports the header rewrite and appended log as 1-indexed line spans", () => {
        const res = buildLogBody({ text: docWith("- **State:** old"), ...args });
        expect(res.ok).toBe(true);
        if (!res.ok) {
            return;
        }

        // Fixture is 12 lines; the append adds a blank separator plus a 13-line
        // log section (topic heading through the quoted After block).
        expect(res.lines).toBe(26);
        expect(res.linesModified).toEqual({
            count: 4,
            lineFirst: 3,
            lineLast: 6,
            heading: "## You are here (2026-07-29 06:47)",
        });
        expect(res.linesAdded).toEqual({
            count: 13,
            lineFirst: 14,
            lineLast: 26,
            heading: "## 2026-07-29 06:47 — second",
        });
    });

    it("shifts the added span when the new header is taller", () => {
        const res = buildLogBody({
            text: docWith("- **State:** old"),
            hereBody: "- **State:** new\n- **Next:** do the thing\n- **Verify:** bun test",
            logBody: "## 2026-07-29 06:47 — second",
            stamp: "2026-07-29 06:47",
        });
        expect(res.ok).toBe(true);
        if (!res.ok) {
            return;
        }

        // Two extra header bullets: the YOU-ARE-HERE block grows by 2, AND the
        // auto-quoted After snapshot grows by the same 2, so the file grows by 4.
        expect(res.lines).toBe(30);
        expect(res.linesModified).toEqual({
            count: 6,
            lineFirst: 3,
            lineLast: 8,
            heading: "## You are here (2026-07-29 06:47)",
        });
        expect(res.linesAdded).toEqual({
            count: 15,
            lineFirst: 16,
            lineLast: 30,
            heading: "## 2026-07-29 06:47 — second",
        });
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

    it("does not let a boolean flag swallow the next flag's value", () => {
        expect(parseFlags(["--all-branches", "--obsidian", "/vault"])).toEqual({
            "all-branches": "",
            obsidian: "/vault",
        });
    });
});

describe("parsePorcelainMain", () => {
    it("returns the first worktree path when it is not this checkout", () => {
        const text = "worktree /repos/Proj\nHEAD abc\n\nworktree /repos/Proj-wt\nHEAD def\n";
        expect(parsePorcelainMain(text, "/repos/Proj-wt")).toBe("/repos/Proj");
    });

    it("returns empty when this checkout is already the main one", () => {
        expect(parsePorcelainMain("worktree /repos/Proj\nHEAD abc\n", "/repos/Proj")).toBe("");
    });

    it("returns empty on blank git output", () => {
        expect(parsePorcelainMain("", "/repos/Proj")).toBe("");
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

describe("log command JSON", () => {
    const fixtures: string[] = [];

    async function tempDir(): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), "wrapup-log-"));
        fixtures.push(dir);
        return dir;
    }

    afterEach(async () => {
        await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it("prints logged, file, stamp, lines, and the added/modified spans", async () => {
        const dir = await tempDir();
        const file = join(dir, "doc.wrapup.md");
        await writeFile(file, docWith("- **State:** old"));

        const proc = Bun.spawn(["bun", join(import.meta.dir, "resolve.ts"), "log", file], {
            env: process.env,
            stdin: new Response("@@HERE@@\n- **State:** new\n@@LOG@@\n## 2026-07-29 06:47 — second\n"),
            stdout: "pipe",
            stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exit = await proc.exited;
        expect(exit).toBe(0);
        expect(stderr).toBe("");

        const json = JSON.parse(stdout);
        expect(json.logged).toBe(true);
        expect(json.file).toBe(file);
        expect(json.stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
        expect(json.lines).toBe(26);
        expect(json.linesAdded).toEqual({
            count: 13,
            lineFirst: 14,
            lineLast: 26,
            heading: "## 2026-07-29 06:47 — second",
        });
        expect(json.linesModified).toEqual({
            count: 4,
            lineFirst: 3,
            lineLast: 6,
            heading: `## You are here (${json.stamp})`,
        });

        const written = await Bun.file(file).text();
        const fileLines = written.endsWith("\n") ? written.slice(0, -1).split("\n") : written.split("\n");
        expect(fileLines).toHaveLength(json.lines);
        expect(fileLines[json.linesModified.lineFirst - 1]).toBe(HERE_START);
        expect(fileLines[json.linesModified.lineFirst]).toBe(json.linesModified.heading);
        expect(fileLines[json.linesModified.lineLast - 1]).toBe(HERE_END);
        expect(fileLines[json.linesAdded.lineFirst - 1]).toBe(json.linesAdded.heading);
        expect(fileLines[json.linesAdded.lineLast - 1]).toBe("> - **State:** new");
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

const PORCELAIN = `worktree /repos/Proj
HEAD aaa
branch refs/heads/feature/next

worktree /repos/Proj-wt-login
HEAD bbb
branch refs/heads/fix/login

worktree /repos/Proj-detached
HEAD ccc
detached
`;

describe("parsePorcelainWorktrees", () => {
    it("reads every checkout with the branch it has out", () => {
        expect(parsePorcelainWorktrees(PORCELAIN)).toEqual([
            { dir: "/repos/Proj", branch: "feature/next" },
            { dir: "/repos/Proj-wt-login", branch: "fix/login" },
            { dir: "/repos/Proj-detached", branch: "detached" },
        ]);
    });

    it("returns nothing when git said nothing", () => {
        expect(parsePorcelainWorktrees("")).toEqual([]);
    });
});

describe("ambientBranchWarnings", () => {
    const worktrees = parsePorcelainWorktrees(PORCELAIN);

    it("warns that an unpinned branch read in the main checkout may not be the session's", () => {
        const warnings = ambientBranchWarnings({
            toplevel: "/repos/Proj",
            branch: "feature/next",
            cwd: "/repos/Proj",
            worktrees,
            pinned: { project: false, branch: false },
        });

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("MAIN checkout");
        expect(warnings[0]).toContain("fix/login");
    });

    it("stays silent once the branch is pinned", () => {
        expect(
            ambientBranchWarnings({
                toplevel: "/repos/Proj",
                branch: "fix/login",
                cwd: "/repos/Proj",
                worktrees,
                pinned: { project: false, branch: true },
            })
        ).toEqual([]);
    });

    it("stays silent for a repo with a single checkout", () => {
        expect(
            ambientBranchWarnings({
                toplevel: "/repos/Solo",
                branch: "main",
                cwd: "/repos/Solo",
                worktrees: [{ dir: "/repos/Solo", branch: "main" }],
                pinned: { project: false, branch: false },
            })
        ).toEqual([]);
    });
});

describe("resolveDocPath", () => {
    const entry: Entry = { projectDir: "/repos/Proj", obsidianDir: "/v/Proj", branch: "feat/x" };
    const ctx = { toplevel: "/repos/Proj", branch: "feat/x", cwd: "/repos/Proj" };

    it("derives the per-branch default when nothing is pinned", () => {
        expect(resolveDocPath(entry, ctx)).toEqual({
            docPath: "/v/Proj/Proj-feat-x.wrapup.md",
            docPathSource: "derived",
        });
    });

    it("puts a bare --doc name inside the matched folder", () => {
        expect(resolveDocPath(entry, ctx, "research-notes.md")).toEqual({
            docPath: "/v/Proj/research-notes.md",
            docPathSource: "pinned",
        });
    });

    it("takes an absolute --doc as given", () => {
        expect(resolveDocPath(entry, ctx, "/elsewhere/other.md").docPath).toBe("/elsewhere/other.md");
    });

    it("reports an entry's own docPath as coming from the entry", () => {
        expect(resolveDocPath({ ...entry, docPath: "/v/Proj/pinned.md" }, ctx)).toEqual({
            docPath: "/v/Proj/pinned.md",
            docPathSource: "entry",
        });
    });
});

describe("ambientBranchWarnings in a linked worktree", () => {
    it("stays silent: the cwd pins the branch as surely as --branch would", () => {
        expect(
            ambientBranchWarnings({
                toplevel: "/repos/Proj-wt-login",
                branch: "fix/login",
                cwd: "/repos/Proj-wt-login",
                mainProject: "/repos/Proj",
                worktrees: parsePorcelainWorktrees(PORCELAIN),
                pinned: { project: false, branch: false },
            })
        ).toEqual([]);
    });
});

describe("siblingWarning", () => {
    it("names the logs already in the folder so a second one is a decision", () => {
        const warnings = siblingWarning(["acme-ticket-4821.wrapup.md"], "/v/Acme/ticket-4821");

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("acme-ticket-4821.wrapup.md");
        expect(warnings[0]).toContain("--doc");
    });

    it("stays silent for an empty folder", () => {
        expect(siblingWarning([], "/v/Acme/ticket-4821")).toEqual([]);
    });

    it("is included in the resolution warnings", () => {
        const warnings = resolutionWarnings({
            entry: { projectDir: "/repos/Proj", obsidianDir: "/v", branch: "feat/x" },
            ctx: { toplevel: "/repos/Proj", branch: "feat/x", cwd: "/repos/Proj" },
            alternatives: [],
            docExists: true,
            siblingDocs: ["other.wrapup.md"],
        });

        expect(warnings.some((w) => w.includes("other.wrapup.md"))).toBe(true);
    });
});

describe("resolve with more than one matching entry", () => {
    const made: string[] = [];

    afterEach(async () => {
        for (const dir of made.splice(0)) {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("lists the runner-up as an alternative instead of throwing", async () => {
        const home = await mkdtemp(join(tmpdir(), "gt-wrapup-home-"));
        const project = await realpath(await mkdtemp(join(tmpdir(), "gt-wrapup-proj-")));

        made.push(home, project);
        await mkdir(join(home, ".genesis-tools", "plugins"), { recursive: true });
        await writeFile(
            join(home, ".genesis-tools", "plugins", "vault-registry.json"),
            JSON.stringify({
                entries: [
                    { projectDir: project, obsidianDir: "/v/older", worktreeDir: undefined },
                    { projectDir: project, obsidianDir: "/v/newer" },
                ],
            })
        );

        const proc = Bun.spawn(["bun", join(import.meta.dir, "resolve.ts"), "resolve", "--cwd", project], {
            env: { ...process.env, GENESIS_TOOLS_HOME: home },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);

        expect(await proc.exited, stderr).toBe(0);

        const result = JSON.parse(stdout);

        expect(result.obsidianDir).toBe("/v/newer");
        expect(result.alternatives).toEqual([
            expect.objectContaining({ obsidianDir: "/v/older", branch: null, worktreeDir: null }),
        ]);
    }, 30_000);
});
