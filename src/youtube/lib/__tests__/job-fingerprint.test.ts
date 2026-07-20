import { describe, expect, it } from "bun:test";
import { buildJobFingerprint } from "@app/youtube/lib/job-fingerprint";

describe("buildJobFingerprint", () => {
    it("joins stages with a comma and leaves an empty params suffix when params is omitted", () => {
        expect(
            buildJobFingerprint({ targetKind: "channel", target: "@opat04", stages: ["discover", "metadata"] })
        ).toBe("channel|@opat04|discover,metadata|");
    });

    it("treats null params the same as omitted params", () => {
        expect(
            buildJobFingerprint({
                targetKind: "channel",
                target: "@opat04",
                stages: ["discover", "metadata"],
                params: null,
            })
        ).toBe("channel|@opat04|discover,metadata|");
    });

    it("sorts param keys and joins them with commas", () => {
        expect(
            buildJobFingerprint({
                targetKind: "video",
                target: "vid00000001",
                stages: ["summarize"],
                params: { mode: "long", language: "en" },
            })
        ).toBe("video|vid00000001|summarize|language=en,mode=long");
    });

    it("is stable regardless of the order params were provided in", () => {
        const a = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["summarize"],
            params: { mode: "long", language: "en" },
        });
        const b = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["summarize"],
            params: { language: "en", mode: "long" },
        });

        expect(a).toBe(b);
    });

    it("hashes a question param to a 16-char hex short-hash instead of embedding raw text", () => {
        const fingerprint = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["qa"],
            params: { question: "What is this video about?" },
        });

        expect(fingerprint).toMatch(/^video\|vid00000001\|qa\|question=[0-9a-f]{16}$/);
        expect(fingerprint).not.toContain("What is this video about");
    });

    it("hashes identical questions to the same fingerprint and different questions to different ones", () => {
        const first = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["qa"],
            params: { question: "What is this video about?" },
        });
        const same = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["qa"],
            params: { question: "What is this video about?" },
        });
        const different = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["qa"],
            params: { question: "How long is this video?" },
        });

        expect(first).toBe(same);
        expect(first).not.toBe(different);
    });

    it("omits params whose value is undefined", () => {
        expect(
            buildJobFingerprint({
                targetKind: "video",
                target: "vid00000001",
                stages: ["summarize"],
                params: { mode: "long", language: undefined },
            })
        ).toBe("video|vid00000001|summarize|mode=long");
    });

    it("ignores ephemeral holdId and creditCost so concurrent requests coalesce", () => {
        const a = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["summarize"],
            params: { mode: "long", language: "en", holdId: 1, creditCost: 10 },
        });
        const b = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["summarize"],
            params: { mode: "long", language: "en", holdId: 99, creditCost: 10 },
        });

        expect(a).toBe(b);
        expect(a).toBe("video|vid00000001|summarize|language=en,mode=long");
    });
});
