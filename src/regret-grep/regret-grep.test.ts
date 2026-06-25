import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { distillEntry } from "./lib/entry";
import { collectBugFixCommits, extractDiffContentLines } from "./lib/git";
import { scoreQuery } from "./lib/similarity";
import { buildIndex, loadIndex } from "./lib/store";
import { fileTypeToken, isBugFixSubject, tokenize } from "./lib/tokenize";
import type { RawCommit } from "./lib/types";

const FIXED_NOW = new Date("2026-06-02T12:00:00.000Z");

async function git(args: string[], cwd: string): Promise<string> {
    const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...env.getProcessEnv(),
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
            GIT_AUTHOR_DATE: "2026-01-01T00:00:00",
            GIT_COMMITTER_DATE: "2026-01-01T00:00:00",
        },
    });

    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
    }

    return stdout;
}

async function writeAndCommit(repo: string, file: string, content: string, message: string): Promise<void> {
    await Bun.write(join(repo, file), content);
    await git(["add", file], repo);
    await git(["commit", "--no-gpg-sign", "-m", message], repo);
}

describe("tokenize", () => {
    test("splits camelCase and drops stop words / short tokens", () => {
        const tokens = tokenize("Fix the parseUserId a b cancel");
        expect(tokens).toContain("parse");
        expect(tokens).toContain("user");
        expect(tokens).toContain("cancel");
        // stop word removed, single-char fragments removed
        expect(tokens).not.toContain("the");
        expect(tokens).not.toContain("a");
        expect(tokens).not.toContain("b");
        expect(tokens.every((t) => t.length >= 2)).toBe(true);
    });

    test("empty input yields no tokens", () => {
        expect(tokenize("")).toEqual([]);
    });
});

describe("isBugFixSubject classifier", () => {
    test("matches bug-fix keywords as whole words", () => {
        expect(isBugFixSubject("fix: null deref in parser")).toBe(true);
        expect(isBugFixSubject("revert broken migration")).toBe(true);
        expect(isBugFixSubject("hotfix login timeout")).toBe(true);
        expect(isBugFixSubject("bug: off-by-one in pager")).toBe(true);
    });

    test("does not match substrings or non-fix subjects", () => {
        expect(isBugFixSubject("add prefix to slug")).toBe(false);
        expect(isBugFixSubject("affixes are formatted")).toBe(false);
        expect(isBugFixSubject("feat: new dashboard")).toBe(false);
        expect(isBugFixSubject("")).toBe(false);
    });
});

describe("fileTypeToken", () => {
    test("returns lowercased extension or noext", () => {
        expect(fileTypeToken("src/foo/Bar.TSX")).toBe("tsx");
        expect(fileTypeToken("Makefile")).toBe("noext");
        expect(fileTypeToken(".gitignore")).toBe("noext");
    });
});

describe("extractDiffContentLines", () => {
    test("keeps +/- content, drops headers and hunk markers", () => {
        const diff = [
            "--- a/file.ts",
            "+++ b/file.ts",
            "@@ -1,2 +1,2 @@",
            "-const x = 1;",
            "+const x = 2;",
            " unchanged",
        ].join("\n");
        const lines = extractDiffContentLines(diff);
        expect(lines).toEqual(["const x = 1;", "const x = 2;"]);
    });
});

describe("scoreQuery (pure lexical ranking)", () => {
    test("ranks the obviously-similar past fix highest", () => {
        const make = (hash: string, subject: string, timestamp: number): RawCommit => ({
            hash,
            subject,
            date: new Date(timestamp * 1000).toISOString(),
            timestamp,
            files: ["src/auth/session.ts"],
            diffLines: tokenize(subject),
        });

        const index = {
            version: 1,
            repo: "/tmp/fake",
            builtAt: FIXED_NOW.toISOString(),
            entries: [
                distillEntry(make("aaa1111", "fix: refresh expired auth session token", 1000)),
                distillEntry(make("bbb2222", "fix: dashboard chart color contrast", 2000)),
                distillEntry(make("ccc3333", "fix: pagination off-by-one in results", 3000)),
            ],
        };

        const query = "diff --git a/src/auth/session.ts\n+    refreshExpiredAuthSessionToken();";
        const matches = scoreQuery(query, index, 5);

        expect(matches.length).toBeGreaterThan(0);
        expect(matches[0].entry.hash).toBe("aaa1111");
        expect(matches[0].score).toBeGreaterThan(0);
        // the auth-session entry must outrank the unrelated ones
        const authScore = matches.find((m) => m.entry.hash === "aaa1111")?.score ?? 0;
        const chartScore = matches.find((m) => m.entry.hash === "bbb2222")?.score ?? 0;
        expect(authScore).toBeGreaterThan(chartScore);
    });

    test("empty index yields no matches", () => {
        const empty = { version: 1, repo: "/tmp/fake", builtAt: FIXED_NOW.toISOString(), entries: [] };
        expect(scoreQuery("anything", empty, 5)).toEqual([]);
    });
});

describe("end-to-end index + check over a throwaway git repo", () => {
    let home: string;
    let repo: string;
    let previousGenesisToolsHome: string | undefined;

    beforeAll(async () => {
        home = mkdtempSync(join(tmpdir(), "regret-home-"));
        repo = mkdtempSync(join(tmpdir(), "regret-repo-"));
        previousGenesisToolsHome = env.get("GENESIS_TOOLS_HOME");
        env.testing.set("GENESIS_TOOLS_HOME", home);

        await git(["init", "-q"], repo);
        await git(["config", "commit.gpgsign", "false"], repo);

        // a non-fix commit (should be ignored by the classifier)
        await writeAndCommit(repo, "feature.ts", "export const dashboard = () => 1;\n", "feat: add dashboard");

        // an obviously-similar past bug-fix
        await writeAndCommit(
            repo,
            "session.ts",
            "export function refreshExpiredAuthSessionToken() {\n    return true;\n}\n",
            "fix: refresh expired auth session token on 401"
        );

        // an unrelated bug-fix
        await writeAndCommit(
            repo,
            "pager.ts",
            "export function paginateResults(page: number) {\n    return page - 1;\n}\n",
            "fix: pagination off-by-one in results list"
        );
    });

    afterAll(() => {
        if (previousGenesisToolsHome === undefined) {
            env.testing.unset("GENESIS_TOOLS_HOME");
        } else {
            env.testing.set("GENESIS_TOOLS_HOME", previousGenesisToolsHome);
        }

        rmSync(home, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
    });

    test("collectBugFixCommits picks only bug-fix commits", async () => {
        const commits = await collectBugFixCommits({
            cwd: repo,
            maxCommits: 100,
            maxDiffBytesPerCommit: 20_000,
        });

        expect(commits.length).toBe(2);
        const subjects = commits.map((c) => c.subject);
        expect(subjects.some((s) => s.includes("auth session"))).toBe(true);
        expect(subjects.some((s) => s.includes("pagination"))).toBe(true);
        expect(subjects.some((s) => s.includes("feat"))).toBe(false);
    });

    test("buildIndex persists, loadIndex round-trips, and check ranks the similar fix first", async () => {
        const built = await buildIndex({ repo, now: FIXED_NOW });
        expect(built.entries.length).toBe(2);
        expect(built.builtAt).toBe(FIXED_NOW.toISOString());

        const loaded = await loadIndex(repo);
        expect(loaded).not.toBeNull();
        expect(loaded?.entries.length).toBe(2);

        // A new diff that re-introduces the auth-session bug pattern.
        const query =
            "diff --git a/session.ts b/session.ts\n" +
            "+export function refreshExpiredAuthSessionToken() {\n" +
            "+    return refreshAuthToken();\n" +
            "+}\n";

        const matches = scoreQuery(query, loaded!, 5);
        expect(matches.length).toBeGreaterThan(0);
        expect(matches[0].entry.subject).toContain("auth session");
    });

    test("loadIndex returns null for a never-indexed repo", async () => {
        const other = mkdtempSync(join(tmpdir(), "regret-other-"));
        try {
            expect(await loadIndex(other)).toBeNull();
        } finally {
            rmSync(other, { recursive: true, force: true });
        }
    });
});
