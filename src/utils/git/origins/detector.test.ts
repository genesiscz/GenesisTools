import { afterEach, describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { TestRepo } from "../test-repo";
import { classifyOriginUrl, detectOrigin, originDriver } from "./detector";
import { ghDriver, parseGhPrList } from "./gh";
import { glabDriver, parseGlabMrList } from "./glab";
import type { CommandRunner } from "./types";

const repos: TestRepo[] = [];

afterEach(() => {
    for (const repo of repos.splice(0)) {
        repo.cleanup();
    }
});

async function repoWithOrigin(url: string | null): Promise<TestRepo> {
    const r = await TestRepo.create({ prefix: "gt-origins-" });
    repos.push(r);

    if (url) {
        await r.git(["remote", "add", "origin", url]);
    }

    return r;
}

describe("classifyOriginUrl", () => {
    it("recognises GitHub in every URL shape", () => {
        for (const url of [
            "git@github.com:genesiscz/GenesisTools.git",
            "ssh://git@github.com/genesiscz/GenesisTools.git",
            "https://github.com/genesiscz/GenesisTools",
            "https://user@github.com/genesiscz/GenesisTools.git",
            "GITHUB.COM:o/r",
        ]) {
            expect(classifyOriginUrl(url)).toMatchObject({ kind: "github", host: "github.com" });
        }
    });

    it("recognises any GitLab host, including self-hosted ones with a port", () => {
        expect(classifyOriginUrl("git@gitlab.com:g/p.git")).toMatchObject({ kind: "gitlab", host: "gitlab.com" });
        expect(classifyOriginUrl("ssh://git@gitlab.apps.corp:2222/g/sub/p.git")).toMatchObject({
            kind: "gitlab",
            host: "gitlab.apps.corp",
        });
        expect(classifyOriginUrl("https://gitlab.apps.corp/g/p")).toMatchObject({ kind: "gitlab" });
    });

    it("has no driver for other hosts or unparsable strings", () => {
        expect(classifyOriginUrl("https://dev.azure.com/org/proj/_git/repo")).toMatchObject({
            kind: null,
            host: "dev.azure.com",
        });
        expect(classifyOriginUrl("git@bitbucket.org:t/r.git").kind).toBeNull();
        expect(classifyOriginUrl("../local/path.git")).toEqual({ url: "../local/path.git", host: null, kind: null });
        expect(classifyOriginUrl("/abs/path.git").host).toBeNull();
    });
});

describe("detectOrigin / originDriver", () => {
    it("returns null without an origin remote", async () => {
        const r = await repoWithOrigin(null);
        expect(await detectOrigin(r.dir)).toBeNull();
        expect(await originDriver(r.dir)).toBeNull();
    });

    it("picks the gh driver for GitHub and the glab driver for GitLab", async () => {
        const gh = await repoWithOrigin("git@github.com:o/r.git");
        expect((await originDriver(gh.dir))?.kind).toBe("github");

        const gl = await repoWithOrigin("https://gitlab.apps.corp/g/p.git");
        expect((await originDriver(gl.dir))?.kind).toBe("gitlab");
    });

    it("returns null for a host without a driver", async () => {
        const r = await repoWithOrigin("https://dev.azure.com/org/proj/_git/repo");
        expect(await detectOrigin(r.dir)).toMatchObject({ host: "dev.azure.com", kind: null });
        expect(await originDriver(r.dir)).toBeNull();
    });
});

describe("gh driver", () => {
    const GH_JSON = SafeJSON.stringify([
        { number: 12, state: "MERGED", baseRefName: "master", url: "https://github.com/o/r/pull/12" },
        { number: 15, state: "OPEN", baseRefName: "feat/parent", url: "https://github.com/o/r/pull/15" },
    ]);

    it("prefers an open PR over an older merged one and maps the fields", () => {
        expect(parseGhPrList(GH_JSON)).toEqual({
            pr: {
                number: 15,
                state: "OPEN",
                target: "feat/parent",
                url: "https://github.com/o/r/pull/15",
            },
            error: null,
        });
        expect(
            parseGhPrList(SafeJSON.stringify([{ number: 1, state: "weird", baseRefName: "m", url: "u" }])).pr?.state
        ).toBe("CLOSED");
    });

    it("separates an empty list from output it could not read", () => {
        expect(parseGhPrList("[]")).toEqual({ pr: null, error: null });

        const unparsable = parseGhPrList("not json");
        expect(unparsable.pr).toBeNull();
        expect(unparsable.error).toContain("unparsable");

        const notAList = parseGhPrList(SafeJSON.stringify({ number: 15 }));
        expect(notAList.pr).toBeNull();
        expect(notAList.error).toContain("not a list");

        const malformed = parseGhPrList(SafeJSON.stringify([{ number: 15, state: "OPEN" }]));
        expect(malformed.pr).toBeNull();
        expect(malformed.error).toContain("no row");
    });

    it("spawns gh with the head filter and turns a failure into null", async () => {
        const calls: string[][] = [];
        const okRunner: CommandRunner = async (cmd) => {
            calls.push(cmd);
            return { code: 0, stdout: GH_JSON, stderr: "" };
        };
        const { pr } = await ghDriver("/repo", okRunner).prForHead("feat/child");
        expect(pr?.number).toBe(15);
        expect(calls[0].slice(0, 5)).toEqual(["gh", "pr", "list", "--head", "feat/child"]);
        expect(calls[0]).toContain("--json");

        const failing: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "gh: not logged in" });
        expect(await ghDriver("/repo", failing).prForHead("feat/child")).toEqual({
            pr: null,
            error: "gh: not logged in",
        });
    });
});

describe("glab driver", () => {
    const GLAB_JSON = SafeJSON.stringify([
        {
            iid: 7,
            state: "closed",
            target_branch: "develop",
            web_url: "https://gitlab.apps.corp/g/p/-/merge_requests/7",
        },
        {
            iid: 9,
            state: "opened",
            target_branch: "feature/next",
            web_url: "https://gitlab.apps.corp/g/p/-/merge_requests/9",
        },
    ]);

    it("maps opened/merged/closed/locked onto the shared vocabulary and prefers open MRs", () => {
        expect(parseGlabMrList(GLAB_JSON)).toEqual({
            pr: {
                number: 9,
                state: "OPEN",
                target: "feature/next",
                url: "https://gitlab.apps.corp/g/p/-/merge_requests/9",
            },
            error: null,
        });
        expect(
            parseGlabMrList(SafeJSON.stringify([{ iid: 1, state: "merged", target_branch: "d", web_url: "u" }])).pr
                ?.state
        ).toBe("MERGED");
        expect(
            parseGlabMrList(SafeJSON.stringify([{ iid: 1, state: "locked", target_branch: "d", web_url: "u" }])).pr
                ?.state
        ).toBe("OPEN");
    });

    it("separates an empty list from output it could not read", () => {
        expect(parseGlabMrList("[]")).toEqual({ pr: null, error: null });

        const unparsable = parseGlabMrList("not json");
        expect(unparsable.pr).toBeNull();
        expect(unparsable.error).toContain("unparsable");

        const malformed = parseGlabMrList(SafeJSON.stringify([{ iid: 9, state: "opened" }]));
        expect(malformed.pr).toBeNull();
        expect(malformed.error).toContain("no row");
    });

    it("spawns glab with --source-branch, --all and JSON output", async () => {
        const calls: string[][] = [];
        const runner: CommandRunner = async (cmd) => {
            calls.push(cmd);
            return { code: 0, stdout: GLAB_JSON, stderr: "" };
        };
        const { pr: mr } = await glabDriver("/repo", runner).prForHead("feat/x");
        expect(mr?.target).toBe("feature/next");
        expect(calls[0]).toEqual(["glab", "mr", "list", "--source-branch", "feat/x", "--all", "--output", "json"]);
    });
});
