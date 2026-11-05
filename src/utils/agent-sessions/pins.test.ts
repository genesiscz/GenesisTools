import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionPin } from "@genesiscz/utils/agent-sessions/pins";
import { loadPins, pinsPath, recordPin } from "@genesiscz/utils/agent-sessions/pins";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { t3ThreadOfSession } from "@genesiscz/utils/t3code/session-thread";
import { t3AppLink } from "@genesiscz/utils/t3code/thread-cli";

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

        test("a journal with a line that does not parse is not compacted, so that line is not deleted", async () => {
            const planted = `{"sessionId":"torn","acc\n${await writeOversizedJournal()}`;
            await writeFile(pinsPath(), planted, "utf8");

            const pins = await loadPins();

            expect(pins.size).toBe(SESSIONS);
            expect(await readFile(pinsPath(), "utf8")).toBe(planted);
        });

        test.each([undefined, null, "damaged"])(
            "an invalid timestamp %s cannot hide a valid pin or permit compaction",
            async (at) => {
                const before = await writeOversizedJournal();
                const damaged = SafeJSON.stringify({ ...pin({ sessionId: "s0", account: "damaged" }), at });
                const valid = SafeJSON.stringify(pin({ sessionId: "s0", account: "personal", at: 5000 }));
                const planted = `${damaged}\n${before}${valid}\n`;
                await writeFile(pinsPath(), planted, "utf8");

                const pins = await loadPins();

                expect(pins.get("s0")?.account).toBe("personal");
                expect(await readFile(pinsPath(), "utf8")).toBe(planted);
            }
        );

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

describe("the host a pin records", () => {
    test("a row with a host and a row without one both load, and only the first carries a host", async () => {
        await mkdir(dirname(pinsPath()), { recursive: true });
        await writeFile(
            pinsPath(),
            `${SafeJSON.stringify(pin({ sessionId: "hosted", host: { kind: "t3", id: "thread-1" } }))}\n` +
                `${SafeJSON.stringify(pin({ sessionId: "plain" }))}\n`
        );

        const pins = await loadPins({ readOnly: true });
        expect(pins.get("hosted")?.host).toEqual({ kind: "t3", id: "thread-1" });
        expect(pins.get("plain")?.host).toBeUndefined();
        expect(pins.get("plain")?.account).toBe("max-primary");
    });
});

describe("one journal, three agents", () => {
    test("a provider filter keeps that agent's records, and an untagged record is claude's", async () => {
        await recordPin(pin({ sessionId: "claude-1", account: "personal" }));
        await recordPin(pin({ sessionId: "codex-1", provider: "codex", account: "work" }));
        await recordPin(pin({ sessionId: "grok-1", provider: "grok", account: "shop" }));

        expect([...(await loadPins({ provider: "claude" })).keys()]).toEqual(["claude-1"]);
        expect([...(await loadPins({ provider: "codex" })).keys()]).toEqual(["codex-1"]);
        expect((await loadPins({ provider: "grok" })).get("grok-1")?.account).toBe("shop");
        // No filter still means everything, so `tools claude cmux` keeps reading the whole file.
        expect((await loadPins()).size).toBe(3);
    });

    /**
     * The real journal holds Codex thread ids that captured a Claude account, from before the
     * hook checked the harness. They carry no `provider`, so a Codex read must not claim them.
     */
    test("an untagged record is never matched as codex, however codex-shaped its id looks", async () => {
        await recordPin(pin({ sessionId: "01a0862a-1cc3-7643-b2b9-2a06424f5276", account: "personal" }));

        expect((await loadPins({ provider: "codex" })).size).toBe(0);
        expect((await loadPins({ provider: "claude" })).size).toBe(1);
    });

    test("a filtered read never compacts, so it cannot delete the other agents' records", async () => {
        const path = pinsPath();
        await mkdir(dirname(path), { recursive: true });
        // Well past COMPACT_THRESHOLD, so an unfiltered read would rewrite the file.
        const lines = Array.from({ length: 4100 }, (_, index) =>
            SafeJSON.stringify(pin({ sessionId: `claude-${index}` }))
        );
        lines.push(SafeJSON.stringify(pin({ sessionId: "codex-1", provider: "codex", account: "work" })));
        await writeFile(path, `${lines.join("\n")}\n`, "utf8");

        expect((await loadPins({ provider: "codex" })).size).toBe(1);
        expect((await readFile(path, "utf8")).split("\n").filter(Boolean)).toHaveLength(lines.length);
    });
});

describe("the parsed journal", () => {
    test("an unchanged journal is parsed once, and an append shows at the next read", async () => {
        await recordPin(pin({ sessionId: "s1", account: "work" }));
        expect((await loadPins({ readOnly: true })).get("s1")?.account).toBe("work");
        const parse = spyOn(SafeJSON, "parse");
        try {
            expect((await loadPins({ readOnly: true })).get("s1")?.account).toBe("work");
            expect((await loadPins({ readOnly: true, provider: "claude" })).size).toBe(1);
            expect(parse).not.toHaveBeenCalled();

            await recordPin(pin({ sessionId: "s1", account: "personal", at: 2_000 }));
            expect((await loadPins({ readOnly: true })).get("s1")?.account).toBe("personal");
        } finally {
            parse.mockRestore();
        }
    });

    test("a provider filter still keeps that agent's newest record when another agent wrote the same id later", async () => {
        await recordPin(pin({ sessionId: "shared", provider: "codex", account: "work", at: 1_000 }));
        await recordPin(pin({ sessionId: "shared", account: "personal", at: 2_000 }));
        expect((await loadPins({ readOnly: true })).get("shared")?.account).toBe("personal");
        expect((await loadPins({ readOnly: true, provider: "codex" })).get("shared")?.account).toBe("work");
    });

    test("a caller that changes its map does not change the next answer", async () => {
        await recordPin(pin({ sessionId: "s1" }));
        const first = await loadPins({ readOnly: true });
        first.delete("s1");
        expect((await loadPins({ readOnly: true })).has("s1")).toBe(true);
    });
});

describe("the T3 Code thread of a session", () => {
    test("is the newest pin's T3 host, and a later pin with no host ends it", async () => {
        await recordPin(pin({ sessionId: "s1", host: { kind: "t3", id: "thread:fixture%3Aone" }, at: 1_000 }));
        expect(await t3ThreadOfSession("s1")).toBe("thread:fixture%3Aone");
        await recordPin(pin({ sessionId: "s1", at: 2_000 }));
        expect(await t3ThreadOfSession("s1")).toBeUndefined();
        await recordPin(pin({ sessionId: "s2", host: { kind: "t3" }, at: 3_000 }));
        expect(await t3ThreadOfSession("s2")).toBeUndefined();
        expect(await t3ThreadOfSession("never-pinned")).toBeUndefined();
    });

    test("the desktop link keeps the thread id percent-encoded as T3 Code prints it", () => {
        expect(t3AppLink("https://app.t3.codes/threads/env-1/thread%3Adelegated-task%3Acommand%253Amcp")).toBe(
            "t3code://threads/env-1/thread%3Adelegated-task%3Acommand%253Amcp"
        );
        expect(t3AppLink("https://app.t3.codes/projects/env-1")).toBeUndefined();
        expect(t3AppLink("not a url")).toBeUndefined();
    });
});
