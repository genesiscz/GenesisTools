import { describe, expect, it } from "bun:test";
import { buildJobFingerprint } from "@app/youtube/lib/job-fingerprint";

describe("buildJobFingerprint", () => {
    it("produces a stable sha1 hex digest", () => {
        const fingerprint = buildJobFingerprint({
            targetKind: "channel",
            target: "@opat04",
            stages: ["discover", "metadata"],
        });

        expect(fingerprint).toMatch(/^[0-9a-f]{40}$/);
    });

    it("treats null params the same as omitted params", () => {
        const omitted = buildJobFingerprint({
            targetKind: "channel",
            target: "@opat04",
            stages: ["discover", "metadata"],
        });
        const explicitNull = buildJobFingerprint({
            targetKind: "channel",
            target: "@opat04",
            stages: ["discover", "metadata"],
            params: null,
        });

        expect(explicitNull).toBe(omitted);
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

    it("distinguishes different param values", () => {
        const long = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["summarize"],
            params: { mode: "long" },
        });
        const short = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["summarize"],
            params: { mode: "short" },
        });

        expect(long).not.toBe(short);
    });

    it("hashes the question param so raw question text never appears in the fingerprint", () => {
        const fingerprint = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["qa"],
            params: { question: "What is this video about?" },
        });

        expect(fingerprint).toMatch(/^[0-9a-f]{40}$/);
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
        const withUndefined = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["summarize"],
            params: { mode: "long", language: undefined },
        });
        const without = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["summarize"],
            params: { mode: "long" },
        });

        expect(withUndefined).toBe(without);
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
        const clean = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["summarize"],
            params: { mode: "long", language: "en" },
        });

        expect(a).toBe(b);
        expect(a).toBe(clean);
    });

    it("does not resist collisions via delimiter injection in free-text params", () => {
        const injected = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["summarize"],
            params: { presetInstructions: "x,mode=y" },
        });
        const split = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["summarize"],
            params: { presetInstructions: "x", mode: "y" },
        });

        expect(injected).not.toBe(split);
    });

    it("scopes user-owned jobs so identical work never coalesces across users", () => {
        const base = {
            targetKind: "video" as const,
            target: "vid00000001",
            stages: ["qa" as const],
            params: { question: "What is this video about?" },
        };
        const userA = buildJobFingerprint({ ...base, userId: 1 });
        const userAAgain = buildJobFingerprint({ ...base, userId: 1 });
        const userB = buildJobFingerprint({ ...base, userId: 2 });
        const anonymous = buildJobFingerprint(base);

        expect(userA).toBe(userAAgain);
        expect(userA).not.toBe(userB);
        expect(userA).not.toBe(anonymous);
    });

    it("treats omitted userId and null userId identically", () => {
        const omitted = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["metadata"],
        });
        const explicitNull = buildJobFingerprint({
            targetKind: "video",
            target: "vid00000001",
            stages: ["metadata"],
            userId: null,
        });

        expect(explicitNull).toBe(omitted);
    });
});
