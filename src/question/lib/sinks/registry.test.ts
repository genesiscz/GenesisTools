import { describe, expect, it } from "bun:test";
import type { QuestionConfig } from "../config";
import type { QaEntry } from "../types";
import { notificationSink } from "./notification";
import { obsidianSink } from "./obsidian";
import { runFanOut } from "./registry";
import { soundSink } from "./sound";
import { type Sink, SinkError } from "./types";

const entry = { id: "1", tag: "question", project: "P" } as unknown as QaEntry;
const cfg = {} as unknown as QuestionConfig;

describe("runFanOut", () => {
    it("returns ok per sink and isolates failures", async () => {
        const sinks: Sink[] = [
            { name: "good", interrupts: false, isEnabled: () => true, emit: async () => {} },
            {
                name: "bad",
                interrupts: false,
                isEnabled: () => true,
                emit: async () => {
                    throw new SinkError("boom", "run fix-it");
                },
            },
            {
                name: "off",
                interrupts: false,
                isEnabled: () => false,
                emit: async () => {
                    throw new Error("should not run");
                },
            },
        ];
        const res = await runFanOut(entry, cfg, { sinks });
        expect(res.find((r) => r.name === "good")?.ok).toBe(true);
        const bad = res.find((r) => r.name === "bad");
        expect(bad?.ok).toBe(false);
        expect(bad?.remedy).toBe("run fix-it");
        expect(res.find((r) => r.name === "off")).toBeUndefined();
    });

    it("times out a hung sink without throwing", async () => {
        const slow: Sink[] = [
            { name: "slow", interrupts: false, isEnabled: () => true, emit: () => new Promise(() => {}) },
        ];
        const t = Date.now();
        const res = await runFanOut(entry, cfg, { sinks: slow, timeoutMs: 200 });
        expect(res[0].ok).toBe(false);
        expect(res[0].error).toMatch(/timeout/i);
        expect(Date.now() - t).toBeLessThan(1000);
    });

    it("skips the sinks that interrupt the user when the record must not interrupt", async () => {
        const rang: string[] = [];
        const sinks: Sink[] = [
            {
                name: "sound",
                interrupts: true,
                isEnabled: () => true,
                emit: () => {
                    rang.push("sound");
                },
            },
            {
                name: "notification",
                interrupts: true,
                isEnabled: () => true,
                emit: () => {
                    rang.push("notification");
                },
            },
            { name: "obsidian", interrupts: false, isEnabled: () => true, emit: () => {} },
        ];

        const quiet = await runFanOut(entry, cfg, { sinks, interrupt: false });

        expect(rang).toEqual([]);
        expect(quiet.map((r) => r.name)).toEqual(["obsidian"]);

        const loud = await runFanOut(entry, cfg, { sinks });

        expect(rang.sort()).toEqual(["notification", "sound"]);
        expect(loud.map((r) => r.name)).toEqual(["sound", "notification", "obsidian"]);
    });

    it("every registered sink says whether it interrupts the user", () => {
        expect(soundSink.interrupts).toBe(true);
        expect(notificationSink.interrupts).toBe(true);
        expect(obsidianSink.interrupts).toBe(false);
    });
});
