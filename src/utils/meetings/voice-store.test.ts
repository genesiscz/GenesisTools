import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { addVoicePrint, readVoiceStore, removeVoicePrint, type VoicePrint } from "./voice-store";

let restoreHome: string;
beforeEach(() => {
    restoreHome = env.tools.getHome();
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "project-voices-")));
});
afterEach(() => env.testing.set("GENESIS_TOOLS_HOME", restoreHome));

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
    const disk = SafeJSON.parse(readFileSync(toolDataDir("meetings", "voice-library", "library.json"), "utf8"));
    expect(disk).toMatchObject({
        version: 2,
        model: "fixture-model",
        samples: [
            { project: "voice-store-fixture", owner: { name: "Alice Example" }, embedding: [0.8, 0.2] },
            { project: "voice-store-fixture", owner: { name: "Bob Example" }, track: "source-call" },
        ],
    });
    expect(existsSync(toolDataDir("meetings", "voices", "voice-store-fixture.json"))).toBe(false);
    expect(readVoiceStore("voice-store-fixture").people["Alice Example"]?.samples).toEqual([
        { ...print, embedding: [0.8, 0.2] },
    ]);
    expect(readVoiceStore("other-voice-project").people).toEqual({});
    expect(removeVoicePrint("voice-store-fixture", "Alice Example", { ...print, meeting: "another" })).toBe(0);
    expect(removeVoicePrint("voice-store-fixture", "Alice Example", print)).toBe(1);
    expect(readVoiceStore("voice-store-fixture").people["Alice Example"]).toBeUndefined();
    expect(readVoiceStore("voice-store-fixture").people["Bob Example"]?.samples).toHaveLength(1);
});

test("removing one print keeps the prints of another track, source or end at the same start", () => {
    const project = "voice-store-siblings-fixture";
    const siblings: VoicePrint[] = [
        { ...print, track: "mic-raw" },
        { ...print, sourceSha: "other-digest" },
        { ...print, toSec: 6 },
    ];
    for (const one of [print, ...siblings]) {
        addVoicePrint(project, "Alice Example", one, "fixture-model");
    }

    expect(removeVoicePrint(project, "Alice Example", print)).toBe(1);
    expect(readVoiceStore(project).people["Alice Example"]?.samples).toEqual(siblings);
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
