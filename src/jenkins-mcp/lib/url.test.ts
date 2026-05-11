import { describe, expect, it } from "bun:test";
import { buildUrl, parseJenkinsInput } from "./url";

describe("parseJenkinsInput", () => {
    it("returns jobPath unchanged when given a path", () => {
        expect(parseJenkinsInput("job/Org/job/Project/job/Team/job/web-build")).toEqual({
            jobPath: "job/Org/job/Project/job/Team/job/web-build",
        });
    });

    it("strips leading and trailing slashes", () => {
        expect(parseJenkinsInput("/job/X/job/Y/").jobPath).toBe("job/X/job/Y");
    });

    it("extracts jobPath + buildNumber from a build URL", () => {
        const r = parseJenkinsInput("https://jenkins.example.com/job/Org/job/Project/job/Team/job/web-build/7948/");
        expect(r.jobPath).toBe("job/Org/job/Project/job/Team/job/web-build");
        expect(r.buildNumber).toBe("7948");
    });

    it("extracts selected-node into nodeId", () => {
        const r = parseJenkinsInput("https://jenkins.example.com/job/X/job/Y/7948/pipeline-overview/?selected-node=41");
        expect(r.buildNumber).toBe("7948");
        expect(r.nodeId).toBe("41");
    });

    it("strips view/<name>/ filter (change-requests view in multibranch)", () => {
        const r = parseJenkinsInput(
            "https://jenkins.example.com/job/X/job/multibranch/view/change-requests/job/PR-42/6/"
        );
        expect(r.jobPath).toBe("job/X/job/multibranch/job/PR-42");
        expect(r.buildNumber).toBe("6");
    });

    it("strips trailing meta segments", () => {
        expect(parseJenkinsInput("https://j.example/job/X/7948/console").buildNumber).toBe("7948");
        expect(parseJenkinsInput("https://j.example/job/X/7948/consoleText").buildNumber).toBe("7948");
        expect(parseJenkinsInput("https://j.example/job/X/7948/pipeline-overview/").buildNumber).toBe("7948");
    });

    it("handles URL with no build number", () => {
        const r = parseJenkinsInput("https://jenkins.example.com/job/X/job/Y/");
        expect(r.jobPath).toBe("job/X/job/Y");
        expect(r.buildNumber).toBeUndefined();
    });
});

describe("buildUrl", () => {
    it("constructs a job URL when no buildNumber", () => {
        expect(buildUrl("https://j.example", { jobPath: "job/X" })).toBe("https://j.example/job/X/");
    });

    it("constructs a build URL", () => {
        expect(buildUrl("https://j.example", { jobPath: "job/X", buildNumber: "7" })).toBe(
            "https://j.example/job/X/7/"
        );
    });

    it("constructs a node-deep-link URL", () => {
        expect(buildUrl("https://j.example", { jobPath: "job/X", buildNumber: "7", nodeId: "41" })).toBe(
            "https://j.example/job/X/7/pipeline-overview/?selected-node=41"
        );
    });

    it("strips trailing slashes from base", () => {
        expect(buildUrl("https://j.example/", { jobPath: "job/X" })).toBe("https://j.example/job/X/");
    });
});
