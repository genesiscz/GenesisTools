import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LiveTranscriptEvent } from "@genesiscz/utils/ai/stt";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { eventsAfterWake } from "./handoff";
import { DEFAULT_WAKE_GATE, disableWakeGate, fixtureWakeEvents, readWakeGate, wakeConfigPath } from "./wake";

test("fixture trigger yields once and cooldown suppresses a second hit", async () => {
    const seen: number[] = [];
    for await (const event of fixtureWakeEvents(
        [
            { atMs: 100, word: "hey jev" },
            { atMs: 200, word: "hey jev" },
            { atMs: 2000, word: "hey jev" },
        ],
        1500
    )) {
        seen.push(event.atMs);
    }
    expect(seen).toEqual([100, 2000]);
});

test("listen sees command words after the wake timestamp", () => {
    const events: LiveTranscriptEvent[] = [
        { kind: "final", text: "hey jev", isFinal: true, startedAtMs: 1000 },
        { kind: "final", text: "click export", isFinal: true, startedAtMs: 1050 },
    ];
    expect(eventsAfterWake(events, 1000).map((event) => event.text)).toEqual(["hey jev", "click export"]);
    expect(eventsAfterWake(events, 1001).map((event) => event.text)).toEqual(["click export"]);
});

describe("wake gate writes", () => {
    let envSnapshot: ReturnType<typeof env.testing.snapshot>;

    beforeEach(() => {
        envSnapshot = env.testing.snapshot();
        env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "jev-wake-")));
    });

    afterEach(() => {
        env.testing.restore(envSnapshot);
    });

    function plant(text: string): void {
        mkdirSync(dirname(wakeConfigPath()), { recursive: true });
        writeFileSync(wakeConfigPath(), text, { mode: 0o600 });
    }

    function corruptCopies(): string[] {
        const dir = dirname(wakeConfigPath());
        return readdirSync(dir)
            .filter((name) => name.startsWith("wake.json.corrupt-"))
            .map((name) => join(dir, name));
    }

    test("disabling a gate file that does not parse keeps the user's bytes in a corrupt- copy", () => {
        const planted = '{"enabled": true, "word": "hey nova", "account": "work", "langu';
        plant(planted);

        disableWakeGate();

        const copies = corruptCopies();
        expect(copies).toHaveLength(1);
        expect(readFileSync(copies[0], "utf8")).toBe(planted);
        expect(readWakeGate().enabled).toBe(false);
        expect(statSync(wakeConfigPath()).mode & 0o777).toBe(0o600);
    });

    test("disabling a valid gate keeps its phrases and account", () => {
        plant(SafeJSON.stringify({ ...DEFAULT_WAKE_GATE, enabled: true, word: "hey nova", account: "work" }));

        disableWakeGate();

        expect(readWakeGate()).toMatchObject({ enabled: false, word: "hey nova", account: "work" });
        expect(corruptCopies()).toEqual([]);
    });
});
