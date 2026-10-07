import { describe, expect, it } from "bun:test";
import {
    normalizeNodeTiming,
    normalizeRunStatus,
    normalizeSnapshot,
    normalizeStageStatus,
    type PipelineSnapshot,
} from "./pipeline";

describe("normalizeStageStatus", () => {
    it("keeps known statuses", () => {
        expect(normalizeStageStatus("SUCCESS")).toBe("SUCCESS");
        expect(normalizeStageStatus("IN_PROGRESS")).toBe("IN_PROGRESS");
        expect(normalizeStageStatus("FAILED")).toBe("FAILED");
        expect(normalizeStageStatus("NOT_EXECUTED")).toBe("NOT_EXECUTED");
    });

    it("maps null/undefined/unknown/QUEUED to NOT_EXECUTED", () => {
        expect(normalizeStageStatus(null)).toBe("NOT_EXECUTED");
        expect(normalizeStageStatus(undefined)).toBe("NOT_EXECUTED");
        expect(normalizeStageStatus("QUEUED")).toBe("NOT_EXECUTED");
        expect(normalizeStageStatus("BOGUS")).toBe("NOT_EXECUTED");
        expect(normalizeStageStatus(42)).toBe("NOT_EXECUTED");
    });
});

describe("normalizeRunStatus", () => {
    it("keeps QUEUED for runs", () => {
        expect(normalizeRunStatus("QUEUED")).toBe("QUEUED");
    });

    it("maps unknown to IN_PROGRESS", () => {
        expect(normalizeRunStatus(null)).toBe("IN_PROGRESS");
        expect(normalizeRunStatus("???")).toBe("IN_PROGRESS");
    });
});

describe("normalizeNodeTiming", () => {
    it("reclassifies SUCCESS with negative duration as IN_PROGRESS with abs duration", () => {
        const out = normalizeNodeTiming({ status: "SUCCESS", durationMillis: -57_751 });
        expect(out.status).toBe("IN_PROGRESS");
        expect(out.durationMillis).toBe(57_751);
    });

    it("reclassifies UNSTABLE with negative duration as IN_PROGRESS", () => {
        const out = normalizeNodeTiming({ status: "UNSTABLE", durationMillis: -120 });
        expect(out.status).toBe("IN_PROGRESS");
        expect(out.durationMillis).toBe(120);
    });

    it("keeps real SUCCESS with non-negative duration", () => {
        const out = normalizeNodeTiming({ status: "SUCCESS", durationMillis: 30_000 });
        expect(out.status).toBe("SUCCESS");
        expect(out.durationMillis).toBe(30_000);
    });

    it("clamps FAILED negative duration to 0 without flipping status", () => {
        const out = normalizeNodeTiming({ status: "FAILED", durationMillis: -500 });
        expect(out.status).toBe("FAILED");
        expect(out.durationMillis).toBe(0);
    });

    it("derives IN_PROGRESS elapsed from startTime when duration missing", () => {
        const now = 1_000_000;
        const out = normalizeNodeTiming({
            status: "IN_PROGRESS",
            startTimeMillis: now - 12_000,
            now,
        });
        expect(out.status).toBe("IN_PROGRESS");
        expect(out.durationMillis).toBe(12_000);
    });

    it("flips abs of negative duration for already-IN_PROGRESS nodes", () => {
        const out = normalizeNodeTiming({ status: "IN_PROGRESS", durationMillis: -3_500 });
        expect(out.status).toBe("IN_PROGRESS");
        expect(out.durationMillis).toBe(3_500);
    });
});

describe("normalizeSnapshot", () => {
    it("normalizes nested stages + branches and clamps run duration", () => {
        const raw = {
            name: "build",
            status: "IN_PROGRESS",
            startTimeMillis: 0,
            durationMillis: -9,
            stages: [
                {
                    id: "97",
                    name: "Tests",
                    status: "SUCCESS",
                    durationMillis: -35,
                },
                {
                    id: "108",
                    name: "Tests",
                    status: null,
                    durationMillis: 0,
                    stageFlowNodes: [
                        {
                            id: "110",
                            name: "sh",
                            status: "QUEUED",
                            durationMillis: -1,
                        },
                    ],
                },
            ],
        } as unknown as PipelineSnapshot;

        const snap = normalizeSnapshot(raw);

        expect(snap.durationMillis).toBe(0);
        expect(snap.stages[0].status).toBe("IN_PROGRESS");
        expect(snap.stages[0].durationMillis).toBe(35);
        expect(snap.stages[1].status).toBe("NOT_EXECUTED");
        expect(snap.stages[1].stageFlowNodes?.[0].status).toBe("NOT_EXECUTED");
    });
});
