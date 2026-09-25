import { describe, expect, test } from "bun:test";
import type { CommandRunner } from "@genesiscz/utils/git";
import { SafeJSON } from "@genesiscz/utils/json";
import { Storage } from "@genesiscz/utils/storage";
import {
    checkFixMarkdown,
    checkFixPrompt,
    checkLog,
    cleanLine,
    errorAnnotations,
    parseCheckUrl,
    parseGithubLog,
    parseGitlabTrace,
    sliceFailedSteps,
} from "./checks";

describe("parseCheckUrl", () => {
    test("GitHub Actions job and run URLs", () => {
        expect(parseCheckUrl("https://github.com/acme/web/actions/runs/11/job/22")).toEqual({
            provider: "github",
            host: "github.com",
            repo: "acme/web",
            runId: 11,
            jobId: 22,
        });
        expect(parseCheckUrl("https://ghe.example.com/acme/web/actions/runs/11/")).toMatchObject({
            host: "ghe.example.com",
            runId: 11,
            jobId: null,
        });
    });

    test("GitLab pipeline and job URLs keep the whole group path", () => {
        expect(parseCheckUrl("https://git.example.com/group/sub/app/-/pipelines/501")).toEqual({
            provider: "gitlab",
            host: "git.example.com",
            project: "group/sub/app",
            pipelineId: 501,
            jobId: null,
        });
        expect(parseCheckUrl("https://git.example.com/group/app/-/jobs/77")).toMatchObject({
            jobId: 77,
            pipelineId: null,
        });
    });

    test("a bot's status page or garbage is not a CI job", () => {
        expect(parseCheckUrl("https://status.example.com/report/1")).toBeNull();
        expect(parseCheckUrl("not a url")).toBeNull();
    });
});

describe("log cleaning", () => {
    test("ANSI in raw and caret form, group markers and carriage-return redraws", () => {
        expect(cleanLine("\u001b[31mred\u001b[0m")).toBe("red");
        expect(cleanLine("^[[36;1mexit 1^[[0m")).toBe("exit 1");
        expect(cleanLine("##[group]Run tests")).toBe("▸ Run tests");
        expect(cleanLine("##[endgroup]")).toBeNull();
        expect(cleanLine("10%\r50%\r100%")).toBe("100%");
        expect(cleanLine("x".repeat(600))).toHaveLength(501);
    });

    test("gh's job and step prefixes are dropped, timestamps kept for the step windows", () => {
        const lines = parseGithubLog(
            [
                "test\tUNKNOWN STEP\t﻿2026-01-02T10:00:00.5000000Z first",
                "test\tUNKNOWN STEP\t2026-01-02T10:00:01.1000000Z ##[error]boom",
                "",
            ].join("\n")
        );
        expect(lines).toEqual([
            { at: Date.parse("2026-01-02T10:00:00.500Z"), text: "first" },
            { at: Date.parse("2026-01-02T10:00:01.100Z"), text: "##[error]boom" },
        ]);
        expect(errorAnnotations(lines)).toEqual(["boom"]);
    });

    test("GitLab section markers go, the text stays", () => {
        const trace =
            "section_start:1700000000:build\r\u001b[0K$ make\nerror: nope\nsection_end:1700000001:build\r\u001b[0K";
        expect(parseGitlabTrace(trace)).toEqual(["$ make", "error: nope"]);
    });
});

describe("sliceFailedSteps", () => {
    const at = (s: number) => Date.parse(`2026-01-02T10:00:${String(s).padStart(2, "0")}.200Z`);
    const lines = [
        { at: at(1), text: "install ok" },
        { at: at(5), text: "running tests" },
        { at: at(6), text: "FAIL a.test.ts" },
        { at: at(6), text: "Post job cleanup." },
        { at: at(6), text: "git config --unset" },
    ];

    test("the failed step's window, without the runner's cleanup that shares its last second", () => {
        const sections = sliceFailedSteps({
            lines,
            jobName: "test",
            maxLines: 10,
            steps: [
                {
                    number: 1,
                    name: "Install",
                    conclusion: "success",
                    startedAt: "2026-01-02T10:00:01Z",
                    completedAt: "2026-01-02T10:00:02Z",
                },
                {
                    number: 2,
                    name: "Run tests",
                    conclusion: "failure",
                    startedAt: "2026-01-02T10:00:05Z",
                    completedAt: "2026-01-02T10:00:06Z",
                },
            ],
        });
        expect(sections).toEqual([
            { name: "test / Run tests", lines: ["running tests", "FAIL a.test.ts"], totalLines: 2 },
        ]);
    });

    test("no failed step (a cancelled job): the log before the cleanup, tailed", () => {
        const sections = sliceFailedSteps({ lines, jobName: "test", maxLines: 2, steps: [] });
        expect(sections).toEqual([{ name: "test", lines: ["running tests", "FAIL a.test.ts"], totalLines: 3 }]);
    });
});

function runner(answers: Array<[RegExp, string]>, calls: string[]): CommandRunner {
    return async (cmd) => {
        const line = cmd.join(" ");
        calls.push(line);
        const hit = answers.find(([pattern]) => pattern.test(line));
        return hit ? { code: 0, stdout: hit[1], stderr: "" } : { code: 1, stdout: "", stderr: `unexpected: ${line}` };
    };
}

let scratch = 0;

/** A fresh cache per test: the suite's GENESIS_TOOLS_HOME is a temp dir, and each tool name gets its own folder. */
function scratchStorage(): Storage {
    scratch += 1;
    return new Storage(`hub-checks-test-${process.pid}-${scratch}`);
}

describe("checkLog", () => {
    const job = SafeJSON.stringify({
        name: "test",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/acme/web/actions/runs/1/job/2",
        steps: [
            {
                number: 1,
                name: "Run tests",
                conclusion: "failure",
                started_at: "2026-01-02T10:00:05Z",
                completed_at: "2026-01-02T10:00:06Z",
            },
        ],
    });
    const log = [
        "test\tUNKNOWN STEP\t2026-01-02T10:00:05.100Z running",
        "test\tUNKNOWN STEP\t2026-01-02T10:00:06.100Z ##[error]Process completed with exit code 1.",
    ].join("\n");

    test("a finished GitHub job: sliced, annotated, cached; the second read makes no host call", async () => {
        const calls: string[] = [];
        const fake = runner(
            [
                [/actions\/jobs\/2$/, job],
                [/run view --job 2 --log/, log],
            ],
            calls
        );
        const storage = scratchStorage();
        const url = "https://github.com/acme/web/actions/runs/1/job/2";
        const first = await checkLog({ url, runner: fake, storage });
        expect(first).toMatchObject({ provider: "github", final: true, cached: false, error: null });
        expect(first.sections[0]).toMatchObject({ name: "test / Run tests", status: "failure" });
        expect(first.errors).toEqual(["Process completed with exit code 1."]);
        expect(calls).toHaveLength(2);

        const second = await checkLog({ url, runner: fake, storage });
        expect(second.cached).toBe(true);
        expect(calls).toHaveLength(2);
    });

    test("a running job is not cached", async () => {
        const calls: string[] = [];
        const running = job.replace('"completed"', '"in_progress"');
        const fake = runner(
            [
                [/actions\/jobs\/2$/, running],
                [/run view --job 2 --log/, log],
            ],
            calls
        );
        const storage = scratchStorage();
        const url = "https://github.com/acme/web/actions/runs/1/job/2";
        await checkLog({ url, runner: fake, storage });
        const again = await checkLog({ url, runner: fake, storage });
        expect(again.cached).toBe(false);
        expect(calls).toHaveLength(4);
    });

    test("a GitLab pipeline reads its failed jobs' traces", async () => {
        const calls: string[] = [];
        const fake = runner(
            [
                [
                    /pipelines\/9\/jobs\?scope%5B%5D=failed/,
                    SafeJSON.stringify([
                        {
                            id: 3,
                            name: "unit",
                            stage: "test",
                            status: "failed",
                            web_url: "https://git.example.com/g/app/-/jobs/3",
                        },
                    ]),
                ],
                [/jobs\/3\/trace$/, "compiling\nerror: broken\n"],
                [/pipelines\/9$/, SafeJSON.stringify({ id: 9, status: "running" })],
            ],
            calls
        );
        const storage = scratchStorage();
        const url = "https://git.example.com/g/app/-/pipelines/9";
        const result = await checkLog({ url, runner: fake, storage });
        // Its failed job is done, but the pipeline still runs: a job that fails later must show up.
        expect(result.final).toBe(false);
        expect((await checkLog({ url, runner: fake, storage })).cached).toBe(false);
        expect(result.sections).toEqual([
            {
                name: "test / unit",
                url: "https://git.example.com/g/app/-/jobs/3",
                status: "failed",
                lines: ["compiling", "error: broken"],
                totalLines: 2,
            },
        ]);
        expect(
            calls.every((line) => line.includes("--hostname git.example.com") && line.includes("projects/g%2Fapp/"))
        ).toBe(true);
    });

    test("a GitLab pipeline log is final once the pipeline itself is done", async () => {
        const fake = runner(
            [
                [/pipelines\/9\/jobs\?scope%5B%5D=failed/, SafeJSON.stringify([{ id: 3, status: "failed" }])],
                [/jobs\/3\/trace$/, "error: broken\n"],
                [/pipelines\/9$/, SafeJSON.stringify({ id: 9, status: "failed" })],
            ],
            []
        );
        const storage = scratchStorage();
        const url = "https://git.example.com/g/app/-/pipelines/9";

        expect((await checkLog({ url, runner: fake, storage })).final).toBe(true);
        expect((await checkLog({ url, runner: fake, storage })).cached).toBe(true);
    });

    test("a host error comes back as error, never a throw; a non-CI URL asks nothing", async () => {
        const calls: string[] = [];
        const failing = await checkLog({
            url: "https://github.com/acme/web/actions/runs/1/job/2",
            runner: runner([], calls),
            storage: scratchStorage(),
        });
        expect(failing.error).toContain("unexpected");

        const external = await checkLog({
            url: "https://status.example.com/x",
            runner: runner([], calls),
            storage: scratchStorage(),
        });
        expect(external.error).toContain("not a GitHub Actions or GitLab CI job");
        expect(calls).toHaveLength(1);
    });
});

describe("send to agent text", () => {
    test("the task file names the PR, the check and the failed tail; the prompt is one line", () => {
        const markdown = checkFixMarkdown({
            checkName: "CI / test",
            prLabel: "#7",
            prUrl: "https://github.com/acme/web/pull/7",
            branch: "feat/x",
            result: {
                url: "https://github.com/acme/web/actions/runs/1/job/2",
                provider: "github",
                sections: [
                    { name: "test / Run tests", url: null, status: "failure", lines: ["FAIL a"], totalLines: 40 },
                ],
                errors: ["exit 1"],
                final: true,
                cached: false,
                fetchedAt: "",
                elapsedMs: 0,
                error: null,
            },
        });
        expect(markdown).toContain("# CI check failed: CI / test");
        expect(markdown).toContain("- exit 1");
        expect(markdown).toContain("## test / Run tests (last 1 of 40 lines)");
        expect(markdown).toContain("Do not post, approve or merge");

        const prompt = checkFixPrompt({ file: "/tmp/task.md", checkName: "CI / test", prLabel: "#7" });
        expect(prompt).not.toContain("\n");
        expect(prompt).toContain("/tmp/task.md");
    });
});
