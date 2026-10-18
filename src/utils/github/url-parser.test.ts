import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import * as realCli from "@genesiscz/utils/cli";

type GitRemoteAnswer = { success: boolean; stdout: string } | Error;

let remoteAnswer: GitRemoteAnswer = { success: true, stdout: "" };
let gitCalls: string[][] = [];

class FakeExecutor {
    async exec(args: string[]): Promise<{ success: boolean; stdout: string }> {
        gitCalls.push(args);

        if (remoteAnswer instanceof Error) {
            throw remoteAnswer;
        }

        return remoteAnswer;
    }
}

mock.module("@genesiscz/utils/cli", () => ({ ...realCli, Executor: FakeExecutor }));

const {
    apiUrlToWebUrl,
    buildGitHubCommitUrl,
    buildGitHubUrl,
    buildRawGitHubUrl,
    detectRepoFromGit,
    extractCommentId,
    extractNumberFromApiUrl,
    parseDate,
    parseGitHubCommitUrl,
    parseGitHubFileUrl,
    parseGitHubUrl,
    parseRepo,
} = await import("./url-parser");

describe("parseGitHubUrl", () => {
    test("reads an issue URL", () => {
        expect(parseGitHubUrl("https://github.com/acme/widgets/issues/123")).toEqual({
            owner: "acme",
            repo: "widgets",
            type: "issue",
            number: 123,
            commentId: undefined,
        });
    });

    test("reads a pull request URL as type pr", () => {
        expect(parseGitHubUrl("https://github.com/acme/widgets/pull/456")).toMatchObject({
            owner: "acme",
            repo: "widgets",
            type: "pr",
            number: 456,
        });
    });

    test("an issue URL with an issuecomment fragment becomes a comment with its id", () => {
        expect(parseGitHubUrl("https://github.com/acme/widgets/issues/123#issuecomment-789")).toEqual({
            owner: "acme",
            repo: "widgets",
            type: "comment",
            number: 123,
            commentId: 789,
        });
    });

    test("a pull request URL with an issuecomment fragment stays a pr and keeps the comment id", () => {
        expect(parseGitHubUrl("https://github.com/acme/widgets/pull/8#issuecomment-55")).toMatchObject({
            type: "pr",
            number: 8,
            commentId: 55,
        });
    });

    test("ignores a trailing path after the number", () => {
        expect(parseGitHubUrl("https://github.com/acme/widgets/pull/8/files")).toMatchObject({
            type: "pr",
            number: 8,
        });
    });

    test("reads the owner/repo#number short form as an issue", () => {
        expect(parseGitHubUrl("acme/widgets#42")).toEqual({
            owner: "acme",
            repo: "widgets",
            type: "issue",
            number: 42,
        });
    });

    test("a bare number or #number takes the repository from the default", () => {
        expect(parseGitHubUrl("7", "acme/widgets")).toEqual({
            owner: "acme",
            repo: "widgets",
            type: "issue",
            number: 7,
        });
        expect(parseGitHubUrl("#7", "acme/widgets")).toMatchObject({ owner: "acme", repo: "widgets", number: 7 });
    });

    test("a bare number without a usable default repository is not a match", () => {
        expect(parseGitHubUrl("#7")).toBeNull();
        expect(parseGitHubUrl("#7", "widgets")).toBeNull();
        expect(parseGitHubUrl("#7", "/widgets")).toBeNull();
    });

    test("text that is no reference is not a match", () => {
        expect(parseGitHubUrl("not a url")).toBeNull();
        expect(parseGitHubUrl("https://github.com/acme/widgets")).toBeNull();
        expect(parseGitHubUrl("https://github.com/acme/widgets/discussions/3")).toBeNull();
    });
});

describe("extractCommentId", () => {
    test("reads the id from an issuecomment fragment", () => {
        expect(extractCommentId("https://github.com/acme/widgets/issues/1#issuecomment-4096")).toBe(4096);
    });

    test("accepts a bare id", () => {
        expect(extractCommentId("4096")).toBe(4096);
    });

    test("rejects anything else", () => {
        expect(extractCommentId("comment-4096")).toBeNull();
        expect(extractCommentId("https://github.com/acme/widgets/issues/1")).toBeNull();
        expect(extractCommentId("")).toBeNull();
    });
});

describe("parseDate", () => {
    const base = new Date(2026, 5, 15, 12, 0, 0);

    beforeEach(() => {
        setSystemTime(base);
    });

    afterEach(() => {
        setSystemTime();
    });

    test("2h goes back two hours", () => {
        expect(parseDate("2h")?.getTime()).toBe(new Date(2026, 5, 15, 10, 0, 0).getTime());
    });

    test("3d goes back three days", () => {
        expect(parseDate("3d")?.getTime()).toBe(new Date(2026, 5, 12, 12, 0, 0).getTime());
    });

    test("2w goes back fourteen days", () => {
        expect(parseDate("2w")?.getTime()).toBe(new Date(2026, 5, 1, 12, 0, 0).getTime());
    });

    test("1m goes back one calendar month", () => {
        expect(parseDate("1m")?.getTime()).toBe(new Date(2026, 4, 15, 12, 0, 0).getTime());
    });

    test("reads an ISO 8601 date", () => {
        expect(parseDate("2026-01-02T03:04:05Z")?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    });

    test("returns null for text that is no date", () => {
        expect(parseDate("yesterday-ish")).toBeNull();
        expect(parseDate("")).toBeNull();
    });
});

describe("buildGitHubUrl", () => {
    test("builds an issue URL", () => {
        expect(buildGitHubUrl("acme", "widgets", "issue", 5)).toBe("https://github.com/acme/widgets/issues/5");
    });

    test("builds a pull request URL with a comment fragment", () => {
        expect(buildGitHubUrl("acme", "widgets", "pr", 5, 99)).toBe(
            "https://github.com/acme/widgets/pull/5#issuecomment-99"
        );
    });

    test("the URL it builds parses back to the same reference", () => {
        const url = buildGitHubUrl("acme", "widgets", "issue", 5, 99);

        expect(parseGitHubUrl(url)).toEqual({
            owner: "acme",
            repo: "widgets",
            type: "comment",
            number: 5,
            commentId: 99,
        });
    });
});

describe("parseRepo", () => {
    test("splits owner/repo", () => {
        expect(parseRepo("acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
    });

    test("rejects a name without an owner or with extra segments", () => {
        expect(parseRepo("widgets")).toBeNull();
        expect(parseRepo("acme/widgets/extra")).toBeNull();
        expect(parseRepo("acme/")).toBeNull();
    });
});

describe("detectRepoFromGit", () => {
    beforeEach(() => {
        gitCalls = [];
        remoteAnswer = { success: true, stdout: "" };
    });

    test("asks git for the origin URL", async () => {
        remoteAnswer = { success: true, stdout: "git@github.com:acme/widgets.git" };
        await detectRepoFromGit();

        expect(gitCalls).toEqual([["remote", "get-url", "origin"]]);
    });

    test("reads an SSH remote", async () => {
        remoteAnswer = { success: true, stdout: "git@github.com:acme/widgets.git" };

        expect(await detectRepoFromGit()).toBe("acme/widgets");
    });

    test("reads an HTTPS remote with and without .git", async () => {
        remoteAnswer = { success: true, stdout: "https://github.com/acme/widgets.git" };
        expect(await detectRepoFromGit()).toBe("acme/widgets");

        remoteAnswer = { success: true, stdout: "https://github.com/acme/widgets" };
        expect(await detectRepoFromGit()).toBe("acme/widgets");
    });

    test("keeps the dots of a repository name, with and without .git, over SSH and HTTPS", async () => {
        for (const stdout of [
            "git@github.com:acme/widgets.js.git",
            "git@github.com:acme/widgets.js",
            "https://github.com/acme/widgets.js.git",
            "https://github.com/acme/widgets.js",
            "https://github.com/acme/widgets.js.git\n",
        ]) {
            remoteAnswer = { success: true, stdout };

            expect(await detectRepoFromGit()).toBe("acme/widgets.js");
        }

        remoteAnswer = { success: true, stdout: "https://github.com/acme/acme.github.io.git" };
        expect(await detectRepoFromGit()).toBe("acme/acme.github.io");
    });

    test("still strips a trailing .git from a plain repository name", async () => {
        remoteAnswer = { success: true, stdout: "git@github.com:acme/widgets.git\n" };

        expect(await detectRepoFromGit()).toBe("acme/widgets");
    });

    test("returns null when git fails, throws, or the remote is not GitHub", async () => {
        remoteAnswer = { success: false, stdout: "" };
        expect(await detectRepoFromGit()).toBeNull();

        remoteAnswer = new Error("git not installed");
        expect(await detectRepoFromGit()).toBeNull();

        remoteAnswer = { success: true, stdout: "https://gitlab.example.com/acme/widgets.git" };
        expect(await detectRepoFromGit()).toBeNull();
    });
});

describe("parseGitHubFileUrl", () => {
    test("reads a blob URL", () => {
        expect(parseGitHubFileUrl("https://github.com/acme/widgets/blob/main/src/index.ts")).toEqual({
            owner: "acme",
            repo: "widgets",
            ref: "main",
            path: "src/index.ts",
            lineStart: undefined,
            lineEnd: undefined,
            isDirectory: false,
        });
    });

    test("reads a blame URL the same way", () => {
        expect(parseGitHubFileUrl("https://github.com/acme/widgets/blame/v1.2.0/README.md")).toMatchObject({
            ref: "v1.2.0",
            path: "README.md",
            isDirectory: false,
        });
    });

    test("a tree URL is a directory", () => {
        expect(parseGitHubFileUrl("https://github.com/acme/widgets/tree/main/src/utils")).toMatchObject({
            ref: "main",
            path: "src/utils",
            isDirectory: true,
        });
    });

    test("reads one line from #L10", () => {
        expect(parseGitHubFileUrl("https://github.com/acme/widgets/blob/main/a.ts#L10")).toMatchObject({
            path: "a.ts",
            lineStart: 10,
            lineEnd: undefined,
        });
    });

    test("reads a range from #L10-L20 and keeps it out of the path", () => {
        expect(parseGitHubFileUrl("https://github.com/acme/widgets/blob/main/a.ts#L10-L20")).toMatchObject({
            path: "a.ts",
            lineStart: 10,
            lineEnd: 20,
        });
    });

    test("reads a raw URL with refs/heads", () => {
        expect(parseGitHubFileUrl("https://raw.githubusercontent.com/acme/widgets/refs/heads/main/docs/a.md")).toEqual({
            owner: "acme",
            repo: "widgets",
            ref: "main",
            path: "docs/a.md",
            lineStart: undefined,
            lineEnd: undefined,
        });
    });

    test("reads a raw URL with refs/tags", () => {
        expect(parseGitHubFileUrl("https://raw.githubusercontent.com/acme/widgets/refs/tags/v2/a.md")).toMatchObject({
            ref: "v2",
            path: "a.md",
        });
    });

    test("reads the simple raw form with the ref as the first segment", () => {
        expect(parseGitHubFileUrl("https://raw.githubusercontent.com/acme/widgets/main/src/a.ts#L3")).toMatchObject({
            owner: "acme",
            repo: "widgets",
            ref: "main",
            path: "src/a.ts",
            lineStart: 3,
        });
    });

    test("a blob or blame URL is a file even when a folder in its path is called tree", () => {
        expect(parseGitHubFileUrl("https://github.com/acme/widgets/blob/main/src/tree/node.ts")).toMatchObject({
            ref: "main",
            path: "src/tree/node.ts",
            isDirectory: false,
        });
        expect(parseGitHubFileUrl("https://github.com/acme/widgets/blame/main/lib/tree/walk.ts#L4")).toMatchObject({
            path: "lib/tree/walk.ts",
            lineStart: 4,
            isDirectory: false,
        });
    });

    test("a tree URL is a directory even when a folder in its path is called blob", () => {
        expect(parseGitHubFileUrl("https://github.com/acme/widgets/tree/main/src/blob")).toMatchObject({
            ref: "main",
            path: "src/blob",
            isDirectory: true,
        });
    });

    test("returns null for a URL that names no file", () => {
        expect(parseGitHubFileUrl("https://github.com/acme/widgets")).toBeNull();
        expect(parseGitHubFileUrl("https://github.com/acme/widgets/blob/main")).toBeNull();
        expect(parseGitHubFileUrl("https://example.com/acme/widgets/blob/main/a.ts")).toBeNull();
    });
});

describe("parseGitHubCommitUrl", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";

    test("reads a full SHA", () => {
        expect(parseGitHubCommitUrl(`https://github.com/acme/widgets/commit/${sha}`)).toEqual({
            owner: "acme",
            repo: "widgets",
            sha,
        });
    });

    test("accepts a short SHA and a trailing fragment, path or query", () => {
        expect(parseGitHubCommitUrl("https://github.com/acme/widgets/commit/abc1234")?.sha).toBe("abc1234");
        expect(parseGitHubCommitUrl("https://github.com/acme/widgets/commit/abc1234#diff-1")?.sha).toBe("abc1234");
        expect(parseGitHubCommitUrl("https://github.com/acme/widgets/commit/abc1234/files")?.sha).toBe("abc1234");
        expect(parseGitHubCommitUrl("https://github.com/acme/widgets/commit/abc1234?w=1")?.sha).toBe("abc1234");
    });

    test("rejects a SHA that is too short or followed by more name characters", () => {
        expect(parseGitHubCommitUrl("https://github.com/acme/widgets/commit/abc123")).toBeNull();
        expect(parseGitHubCommitUrl("https://github.com/acme/widgets/commit/abc1234zz")).toBeNull();
    });

    test("rejects a URL that is no commit", () => {
        expect(parseGitHubCommitUrl("https://github.com/acme/widgets/pull/5")).toBeNull();
    });
});

describe("buildGitHubCommitUrl", () => {
    test("without a PR number points at the repository commit", () => {
        expect(buildGitHubCommitUrl("acme", "widgets", "abc1234")).toBe(
            "https://github.com/acme/widgets/commit/abc1234"
        );
    });

    test("with a PR number points at the commit inside the pull request", () => {
        expect(buildGitHubCommitUrl("acme", "widgets", "abc1234", 12)).toBe(
            "https://github.com/acme/widgets/pull/12/commits/abc1234"
        );
    });
});

describe("buildRawGitHubUrl", () => {
    test("builds a raw.githubusercontent.com URL that parseGitHubFileUrl reads back", () => {
        const url = buildRawGitHubUrl("acme", "widgets", "main", "src/a.ts");

        expect(url).toBe("https://raw.githubusercontent.com/acme/widgets/main/src/a.ts");
        expect(parseGitHubFileUrl(url)).toMatchObject({
            owner: "acme",
            repo: "widgets",
            ref: "main",
            path: "src/a.ts",
        });
    });
});

describe("apiUrlToWebUrl", () => {
    const repoUrl = "https://github.com/acme/widgets";

    test("maps an issue API URL to its web page", () => {
        expect(apiUrlToWebUrl("https://api.github.com/repos/acme/widgets/issues/123", repoUrl)).toBe(
            "https://github.com/acme/widgets/issues/123"
        );
    });

    test("maps pulls to the singular pull path", () => {
        expect(apiUrlToWebUrl("https://api.github.com/repos/acme/widgets/pulls/456", repoUrl)).toBe(
            "https://github.com/acme/widgets/pull/456"
        );
    });

    test("maps commits to the singular commit path", () => {
        expect(apiUrlToWebUrl("https://api.github.com/repos/acme/widgets/commits/abc1234", repoUrl)).toBe(
            "https://github.com/acme/widgets/commit/abc1234"
        );
    });

    test("maps a release to the releases page", () => {
        expect(apiUrlToWebUrl("https://api.github.com/repos/acme/widgets/releases/99", repoUrl)).toBe(
            "https://github.com/acme/widgets/releases"
        );
    });

    test("falls back to the repository page for null and for unknown resources", () => {
        expect(apiUrlToWebUrl(null, repoUrl)).toBe(repoUrl);
        expect(apiUrlToWebUrl("https://api.github.com/repos/acme/widgets/labels/bug", repoUrl)).toBe(repoUrl);
        expect(apiUrlToWebUrl("https://example.com/other", repoUrl)).toBe(repoUrl);
    });
});

describe("extractNumberFromApiUrl", () => {
    test("reads the number from an issue or pull API URL", () => {
        expect(extractNumberFromApiUrl("https://api.github.com/repos/acme/widgets/issues/123")).toBe(123);
        expect(extractNumberFromApiUrl("https://api.github.com/repos/acme/widgets/pulls/456")).toBe(456);
    });

    test("returns null for null, other resources and a URL with a trailing segment", () => {
        expect(extractNumberFromApiUrl(null)).toBeNull();
        expect(extractNumberFromApiUrl("https://api.github.com/repos/acme/widgets/commits/9")).toBeNull();
        expect(extractNumberFromApiUrl("https://api.github.com/repos/acme/widgets/issues/9/comments")).toBeNull();
    });
});
