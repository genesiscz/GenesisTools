import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { addVoicePrint, readVoiceStore, removeVoicePrint, type VoicePrint, voiceStoreSchema } from "./voice-store";

const print: VoicePrint = {
    meeting: "planning",
    sourceSha: "source-digest",
    seat: "mic",
    track: "source-mic",
    fromSec: 2,
    toSec: 5,
    embedding: [1, 0],
    confirmedAt: "2026-11-01T10:00:00Z",
    question: "i1",
};

test("project prints persist, reopen, deduplicate and remove without leaking across projects", () => {
    addVoicePrint("voice-store-fixture", "Alice Example", print, "fixture-model");
    addVoicePrint("voice-store-fixture", "Alice Example", { ...print, embedding: [0.8, 0.2] }, "fixture-model");
    addVoicePrint(
        "voice-store-fixture",
        "Bob Example",
        { ...print, seat: "call", track: "source-call" },
        "fixture-model"
    );
    const disk = voiceStoreSchema.parse(
        SafeJSON.parse(readFileSync(toolDataDir("meetings", "voices", "voice-store-fixture.json"), "utf8"))
    );
    expect(disk.model).toBe("fixture-model");
    expect(disk.people["Alice Example"]?.samples).toEqual([{ ...print, embedding: [0.8, 0.2] }]);
    expect(readVoiceStore("other-voice-project").people).toEqual({});
    expect(removeVoicePrint("voice-store-fixture", "Alice Example", { meeting: "another", fromSec: 2 })).toBe(0);
    expect(removeVoicePrint("voice-store-fixture", "Alice Example", { meeting: "planning", fromSec: 2 })).toBe(1);
    expect(readVoiceStore("voice-store-fixture").people["Alice Example"]).toBeUndefined();
    expect(readVoiceStore("voice-store-fixture").people["Bob Example"]?.samples).toHaveLength(1);
});

test("invalid project paths, mismatched seats and changed models cannot overwrite stored prints", () => {
    expect(() => readVoiceStore("../escape")).toThrow();
    expect(() =>
        addVoicePrint("invalid-voice-fixture", "Alice Example", { ...print, track: "system" }, "model")
    ).toThrow();
    addVoicePrint("model-voice-fixture", "Alice Example", print, "first-model");
    expect(() => addVoicePrint("model-voice-fixture", "Alice Example", print, "other-model")).toThrow("model changed");
    expect(readVoiceStore("model-voice-fixture").model).toBe("first-model");
});
