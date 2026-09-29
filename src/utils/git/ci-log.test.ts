import { describe, expect, test } from "bun:test";
import {
    cleanLine,
    errorAnnotations,
    parseCheckUrl,
    parseGithubLog,
    parseGitlabTrace,
    sliceFailedSteps,
} from "./ci-log";

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
