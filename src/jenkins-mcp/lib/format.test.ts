import { describe, expect, it } from "bun:test";
import { formatStageLine, slugifyJobPath, stageNotifyBody, statusBody, statusIcon } from "./format";

describe("slugifyJobPath", () => {
    it("collapses job/ segments to dashes", () => {
        expect(slugifyJobPath("job/Org/job/Project/job/Team/job/web-build")).toBe("Org-Project-Team-web-build");
    });

    it("handles already-clean input", () => {
        expect(slugifyJobPath("foo")).toBe("foo");
    });

    it("strips leading/trailing slashes", () => {
        expect(slugifyJobPath("/job/X/")).toBe("X");
    });
});

describe("statusIcon", () => {
    it("maps known statuses", () => {
        expect(statusIcon("SUCCESS")).toBe("✓");
        expect(statusIcon("FAILED")).toBe("✗");
        expect(statusIcon("IN_PROGRESS")).toBe("⏳");
        expect(statusIcon("NOT_EXECUTED")).toBe("⏸");
        expect(statusIcon("ABORTED")).toBe("⊘");
        expect(statusIcon("UNSTABLE")).toBe("⚠");
    });
});

describe("statusBody", () => {
    it("includes icon + readable status", () => {
        expect(statusBody("SUCCESS")).toContain("SUCCESS");
        expect(statusBody("FAILED")).toContain("FAILED");
        expect(statusBody("IN_PROGRESS")).toContain("running");
    });
});

describe("formatStageLine", () => {
    it("running stage shows 'running for X'", () => {
        const now = Date.now();
        const line = formatStageLine(
            {
                id: "1",
                name: "Tests",
                status: "IN_PROGRESS",
                startTimeMillis: now - 24_000,
            },
            now
        );
        expect(line).toContain("Tests");
        expect(line).toContain("running for");
    });

    it("completed stage shows duration", () => {
        const line = formatStageLine({
            id: "1",
            name: "Clone",
            status: "SUCCESS",
            durationMillis: 22_000,
        });
        expect(line).toContain("Clone");
        expect(line).toContain("SUCCESS");
    });

    it("works for FlowNode (branches inside parallel stages)", () => {
        const line = formatStageLine({
            id: "47",
            name: "Build COL Web",
            status: "SUCCESS",
            durationMillis: 5000,
        });
        expect(line).toContain("Build COL Web");
    });
});

describe("stageNotifyBody", () => {
    it("includes status + duration when known", () => {
        const body = stageNotifyBody({
            id: "1",
            name: "Clone",
            status: "SUCCESS",
            durationMillis: 22_000,
        });
        expect(body).toContain("SUCCESS");
    });

    it("omits duration when unknown", () => {
        const body = stageNotifyBody({ id: "1", name: "X", status: "IN_PROGRESS" });
        expect(body).toContain("running");
    });
});
