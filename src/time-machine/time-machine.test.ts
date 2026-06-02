import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTimeMachine } from "./index";
import { type BisectPredicate, type CommitStatus, findFirstBad } from "./lib/bisect";

describe("findFirstBad (pure algorithm)", () => {
    const fromStatuses = (statuses: CommitStatus[]): BisectPredicate => {
        return (index) => statuses[index];
    };

    it("returns null firstBad when every commit passes", async () => {
        const commits = ["a", "b", "c", "d"];
        const result = await findFirstBad(commits, fromStatuses(["pass", "pass", "pass", "pass"]));

        expect(result.firstBad).toBeNull();
        expect(result.firstBadIndex).toBe(-1);
        expect(result.lastGood).toBe("d");
        expect(result.lastGoodIndex).toBe(3);
    });

    it("blames index 0 when every commit fails (no green parent)", async () => {
        const commits = ["a", "b", "c", "d"];
        const result = await findFirstBad(commits, fromStatuses(["fail", "fail", "fail", "fail"]));

        expect(result.firstBad).toBe("a");
        expect(result.firstBadIndex).toBe(0);
        expect(result.lastGood).toBeNull();
        expect(result.lastGoodIndex).toBe(-1);
    });

    it("finds the first failing commit at a mid-list transition", async () => {
        // oldest → newest: pass pass pass FAIL fail fail
        const commits = ["c0", "c1", "c2", "c3", "c4", "c5"];
        const result = await findFirstBad(commits, fromStatuses(["pass", "pass", "pass", "fail", "fail", "fail"]));

        expect(result.firstBad).toBe("c3");
        expect(result.firstBadIndex).toBe(3);
        expect(result.lastGood).toBe("c2");
        expect(result.lastGoodIndex).toBe(2);
    });

    it("performs at most ceil(log2(n))+1 probes (binary, not linear)", async () => {
        const n = 64;
        const commits = Array.from({ length: n }, (_, i) => `c${i}`);
        const transition = 40;
        const statuses: CommitStatus[] = commits.map((_, i) => (i < transition ? "pass" : "fail"));
        const result = await findFirstBad(commits, fromStatuses(statuses));

        expect(result.firstBadIndex).toBe(transition);
        // log2(64) = 6; allow a small slack for the lower-bound search shape.
        expect(result.probes).toBeLessThanOrEqual(8);
    });

    it("handles the empty commit list", async () => {
        const result = await findFirstBad([], () => "fail");
        expect(result.firstBad).toBeNull();
        expect(result.probes).toBe(0);
    });
});

describe("runTimeMachine (integration, tmp git repo)", () => {
    let repos: string[] = [];

    afterEach(async () => {
        await Promise.all(repos.map((dir) => rm(dir, { recursive: true, force: true })));
        repos = [];
    });

    /**
     * Build a deterministic, hermetic tmp git repo. Each commit either writes
     * "ok" or "broken" into marker.txt; the predicate command (a portable
     * `grep -q ok marker.txt`) passes only on commits whose marker says "ok".
     * Fixed author identity + dates so no host git config is required and the
     * run is reproducible.
     */
    async function makeRepo(markers: string[]): Promise<{ dir: string; shas: string[] }> {
        const dir = await mkdtemp(join(tmpdir(), "tm-test-"));
        repos.push(dir);

        const baseDate = "2026-01-01T00:00:00Z";
        const env = {
            ...process.env,
            GIT_AUTHOR_NAME: "TM Test",
            GIT_AUTHOR_EMAIL: "tm@test.local",
            GIT_COMMITTER_NAME: "TM Test",
            GIT_COMMITTER_EMAIL: "tm@test.local",
            GIT_AUTHOR_DATE: baseDate,
            GIT_COMMITTER_DATE: baseDate,
        };

        const git = async (args: string[]): Promise<void> => {
            const proc = Bun.spawn(["git", ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
            const exitCode = await proc.exited;
            if (exitCode !== 0) {
                const stderr = await new Response(proc.stderr).text();
                throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
            }
        };

        await git(["init", "-q", "-b", "main"]);
        await git(["config", "commit.gpgsign", "false"]);

        const shas: string[] = [];
        for (let i = 0; i < markers.length; i++) {
            // Include the index so consecutive same-marker commits still produce
            // a real diff (git refuses an empty commit). The predicate only
            // looks at the `marker:` line, so the index line is inert.
            await writeFile(join(dir, "marker.txt"), `seq:${i}\nmarker:${markers[i]}\n`);
            await git(["add", "marker.txt"]);
            await git(["commit", "-q", "-m", `commit ${i}: ${markers[i]}`]);

            const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
            const sha = (await new Response(proc.stdout).text()).trim();
            await proc.exited;
            shas.push(sha);
        }

        return { dir, shas };
    }

    const PREDICATE = ["sh", "-c", "grep -q '^marker:ok$' marker.txt"];

    it("finds the exact commit that introduced the failure", async () => {
        // History (oldest → newest): ok, ok, broken, broken, broken.
        // Commit index 2 is the first BAD one; index 1 is the last good.
        const { dir, shas } = await makeRepo(["ok", "ok", "broken", "broken", "broken"]);

        const report = await runTimeMachine(PREDICATE, { depth: 30, good: null, cwd: dir });

        expect(report.status).toBe("found");
        expect(report.firstBad?.sha).toBe(shas[2]);
        expect(report.lastGood?.sha).toBe(shas[1]);
        expect(report.diff).toContain("marker.txt");
        expect(report.diff).toContain("broken");
    });

    it("reports already-green when the command passes at HEAD", async () => {
        const { dir } = await makeRepo(["ok", "ok", "ok"]);

        const report = await runTimeMachine(PREDICATE, { depth: 30, good: null, cwd: dir });

        expect(report.status).toBe("already-green");
        expect(report.firstBad).toBeUndefined();
    });

    it("reports predates-range when even the oldest searched commit fails", async () => {
        // Every commit is broken → no green parent within the window.
        const { dir } = await makeRepo(["broken", "broken", "broken"]);

        const report = await runTimeMachine(PREDICATE, { depth: 30, good: null, cwd: dir });

        expect(report.status).toBe("predates-range");
        expect(report.lastGood ?? null).toBeNull();
    });

    it("honors --good to narrow the search window", async () => {
        // oldest → newest: ok, ok, broken, broken. Seed good = shas[1] so the
        // window is shas[2..3]; the first bad is still shas[2].
        const { dir, shas } = await makeRepo(["ok", "ok", "broken", "broken"]);

        const report = await runTimeMachine(PREDICATE, { depth: 30, good: shas[1], cwd: dir });

        expect(report.status).toBe("found");
        expect(report.firstBad?.sha).toBe(shas[2]);
        // Only two commits should be in the window (shas[2], shas[3]).
        expect(report.candidates).toBe(2);
    });
});
