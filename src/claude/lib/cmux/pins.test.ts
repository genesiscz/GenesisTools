import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadPins, pinsPath, recordPin } from "@app/claude/lib/cmux/pins";
import type { SessionPin } from "@app/claude/lib/cmux/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

let home: string;
let envSnapshot: ReturnType<typeof env.testing.snapshot>;

function pin(overrides: Partial<SessionPin> & { sessionId: string }): SessionPin {
    return {
        account: "max-primary",
        model: null,
        cwd: "/Users/me/Projects/App",
        workspaceId: null,
        source: "hook",
        at: 1_000,
        ...overrides,
    };
}

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "claude-cmux-pins-"));
    envSnapshot = env.testing.snapshot();
    env.testing.set("GENESIS_TOOLS_HOME", home);
});

afterEach(async () => {
    env.testing.restore(envSnapshot);
    await rm(home, { recursive: true, force: true });
});

describe("pins", () => {
    test("an absent journal reads as no pins, not an error", async () => {
        expect(await loadPins()).toEqual(new Map());
    });

    test("records and reads back a pin", async () => {
        await recordPin(pin({ sessionId: "a", model: "opus" }));

        const pins = await loadPins();

        expect(pins.get("a")).toMatchObject({ account: "max-primary", model: "opus" });
    });

    test("a later write for the same session wins", async () => {
        await recordPin(pin({ sessionId: "a", account: "first", at: 1 }));
        await recordPin(pin({ sessionId: "a", account: "second", at: 2 }));

        expect((await loadPins()).get("a")?.account).toBe("second");
    });

    test("an out-of-order append does not overwrite a newer pin", async () => {
        await recordPin(pin({ sessionId: "a", account: "newer", at: 10 }));
        await recordPin(pin({ sessionId: "a", account: "older", at: 5 }));

        expect((await loadPins()).get("a")?.account).toBe("newer");
    });

    test("a null account is a real answer (keychain login), not a missing one", async () => {
        await recordPin(pin({ sessionId: "a", account: null }));

        const found = (await loadPins()).get("a");

        expect(found).toBeDefined();
        expect(found?.account).toBeNull();
    });

    test("a torn line is skipped and the rest still loads", async () => {
        await recordPin(pin({ sessionId: "a" }));
        await writeFile(pinsPath(), `${await readFile(pinsPath(), "utf8")}{"sessionId":"b",\n`, "utf8");
        await recordPin(pin({ sessionId: "c" }));

        const pins = await loadPins();

        expect([...pins.keys()].sort()).toEqual(["a", "c"]);
    });

    describe("readOnly", () => {
        const SESSIONS = 100;
        const LINES = 4100; // past COMPACT_THRESHOLD (4000)

        /** Repeated re-pins of the same sessions, so compaction genuinely shrinks the file. */
        async function writeOversizedJournal(): Promise<string> {
            const lines = Array.from({ length: LINES }, (_, i) =>
                SafeJSON.stringify(pin({ sessionId: `s${i % SESSIONS}`, at: i }))
            );
            await mkdir(dirname(pinsPath()), { recursive: true });
            await writeFile(pinsPath(), `${lines.join("\n")}\n`, "utf8");

            return readFile(pinsPath(), "utf8");
        }

        async function journalLines(): Promise<number> {
            return (await readFile(pinsPath(), "utf8")).trimEnd().split("\n").length;
        }

        test("a normal read still compacts an oversized journal", async () => {
            await writeOversizedJournal();
            expect(await journalLines()).toBe(LINES);

            await loadPins();

            expect(await journalLines()).toBe(SESSIONS);
        });

        test("readOnly leaves the journal byte-identical", async () => {
            // `--dry-run` reaches loadPins through listCandidates. Compaction there
            // would make an inspection mutate durable state.
            const before = await writeOversizedJournal();

            const pins = await loadPins({ readOnly: true });

            expect(pins.size).toBe(SESSIONS);
            expect(await readFile(pinsPath(), "utf8")).toBe(before);
        });
    });
});
