import { describe, expect, it } from "bun:test";
import type { QuestionConfig } from "../config";
import { soundSink } from "./sound";

const base: Omit<QuestionConfig, "sinks"> = { obsidianPathTemplate: "" };

describe("soundSink", () => {
    it("disabled by default config (terminal)", () => {
        expect(soundSink.isEnabled({ ...base, sinks: { obsidian: true, sound: false, notify: false } })).toBe(false);
    });

    it("enabled when configured on", () => {
        expect(soundSink.isEnabled({ ...base, sinks: { obsidian: true, sound: true, notify: false } })).toBe(true);
    });
});
