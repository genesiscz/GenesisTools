import { describe, expect, it } from "bun:test";
import { mcpLogArgs, parseLineCount, resolveTarget } from "./buildLog";

describe("resolveTarget", () => {
    it("keeps an explicit build, and leaves a build URL's own number alone", () => {
        expect(resolveTarget("job/app", "12")).toEqual({ target: "job/app", build: "12" });
        expect(resolveTarget("https://jenkins.example.com/job/app/7401/")).toEqual({
            target: "https://jenkins.example.com/job/app/7401/",
        });
        expect(
            resolveTarget("https://jenkins.example.com/job/app/7401/pipeline-overview/?selected-node=41").build
        ).toBeUndefined();
    });

    it("splits a job path that ends in a build number", () => {
        expect(resolveTarget("job/app/7401")).toEqual({ target: "job/app", build: "7401" });
        expect(resolveTarget("job/app/7401/")).toEqual({ target: "job/app", build: "7401" });
    });

    it("means the last build for a bare job path or job URL", () => {
        expect(resolveTarget("job/app")).toEqual({ target: "job/app", build: "lastBuild" });
        expect(resolveTarget("https://jenkins.example.com/job/app/").build).toBe("lastBuild");
    });
});

describe("mcpLogArgs", () => {
    it("passes only the options that were given", () => {
        expect(mcpLogArgs({ target: "job/app/7" })).toEqual(["log", "job/app", "--build", "7"]);
        expect(mcpLogArgs({ target: "job/app", build: "lastBuild", node: "41", tail: 100 })).toEqual([
            "log",
            "job/app",
            "--build",
            "lastBuild",
            "--node",
            "41",
            "--tail",
            "100",
        ]);
    });

    it("maps a search to --grep and a head to --head", () => {
        expect(mcpLogArgs({ target: "job/app", build: "7", grep: "ERROR|FAILURE" })).toEqual([
            "log",
            "job/app",
            "--build",
            "7",
            "--grep",
            "ERROR|FAILURE",
        ]);
        expect(mcpLogArgs({ target: "job/app", head: 5 })).toEqual([
            "log",
            "job/app",
            "--build",
            "lastBuild",
            "--head",
            "5",
        ]);
    });
});

describe("parseLineCount", () => {
    it("accepts a positive whole number only", () => {
        expect(parseLineCount("20")).toBe(20);
        expect(() => parseLineCount("0")).toThrow("positive whole number");
        expect(() => parseLineCount("x")).toThrow("positive whole number");
    });
});
