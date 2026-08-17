/**
 * The pure parts of `play`: window-spec parsing, tracks-file loading, and the
 * evaluate_script result parser. The driver itself needs a live browser and is
 * exercised by hand; these are the pieces a typo would silently break.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { playDir } from "@app/spotify/lib/paths";
import { appendJournal, clearJournal, journalPath, progressFor } from "@app/spotify/lib/play/journal";
import { FIND_PLAYER, parsePayloadResult } from "@app/spotify/lib/play/payloads";
import {
    findPlan,
    formatWindows,
    listPlans,
    loadPlan,
    loadTracks,
    newestPlan,
    type PlayWindow,
    parseWindows,
    writePlan,
} from "@app/spotify/lib/play/plan";
import { SEED_SOURCES } from "@app/spotify/lib/play/seed";
import { SafeJSON } from "@genesiscz/utils/json";

const CLI = resolve(dirname(import.meta.dir), "index.ts");
const root = mkdtempSync(join(tmpdir(), "spotify-play-test-"));

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("parseWindows", () => {
    test("parses multi-window specs", () => {
        expect(parseWindows("10:3,20:3,30:3")).toEqual([
            [10, 3],
            [20, 3],
            [30, 3],
        ]);
    });

    test("parses a single window with spaces", () => {
        expect(parseWindows(" 40:30 ")).toEqual([[40, 30]]);
    });

    // `10:3:5` used to destructure to [10, 3] and drop the rest without a word.
    test.each(["10", "a:b", "-5:3", "10:0", "10:3:5", "::"])("rejects '%s' naming the chunk", (chunk) => {
        expect(() => parseWindows(chunk)).toThrow(chunk.trim());
    });

    test("rejects an empty spec", () => {
        expect(() => parseWindows(" , ")).toThrow("no windows");
    });

    test("round-trips through formatWindows", () => {
        const spec = "10:3,45:12";
        expect(formatWindows(parseWindows(spec))).toBe(spec);
    });
});

describe("loadTracks", () => {
    const write = (name: string, value: unknown): string => {
        const path = join(root, name);
        writeFileSync(path, `${SafeJSON.stringify(value)}\n`);

        return path;
    };

    test("accepts a bare array and keeps per-track windows", () => {
        const path = write("bare.json", [
            { uri: "spotify:track:a", name: "A" },
            { uri: "spotify:track:b", name: "B", windows: [[40, 30]] },
        ]);
        const tracks = loadTracks(path);
        expect(tracks).toHaveLength(2);
        expect(tracks[1]?.windows).toEqual([[40, 30]]);
    });

    test("accepts the {all: [...]} harvest shape", () => {
        const path = write("all.json", { all: [{ uri: "spotify:track:a" }] });
        expect(loadTracks(path)).toHaveLength(1);
    });

    test("names the entry missing a spotify: uri", () => {
        const path = write("bad.json", [{ uri: "spotify:track:a" }, { name: "no uri" }]);
        expect(() => loadTracks(path)).toThrow("entry 1");
    });

    test("rejects a non-track shape", () => {
        const path = write("shape.json", { rows: [] });
        expect(() => loadTracks(path)).toThrow("neither an array");
    });

    test("names a missing file", () => {
        expect(() => loadTracks(join(root, "nope.json"))).toThrow("not found");
    });
});

describe("parsePayloadResult", () => {
    test("digs the object out of a ```json fence", () => {
        const raw = 'Ran script.\n```json\n{"ok": true, "track": "A — B"}\n```\n';
        expect(parsePayloadResult<{ ok: boolean; track: string }>(raw)).toEqual({ ok: true, track: "A — B" });
    });

    test("falls back to the first brace when unfenced", () => {
        expect(parsePayloadResult<{ ok: boolean }>('result: {"ok": false}')).toEqual({ ok: false });
    });

    test("returns null for garbage instead of throwing", () => {
        expect(parsePayloadResult("no json here")).toBeNull();
    });
});

describe("named plans", () => {
    // The test harness already points GENESIS_TOOLS_HOME at a sandbox, so these write into
    // its play directory rather than a real one. Clearing it per test is what keeps the
    // listing assertions independent of each other.
    beforeEach(() => {
        rmSync(playDir(), { recursive: true, force: true });
    });

    afterAll(() => {
        rmSync(playDir(), { recursive: true, force: true });
    });

    const make = (name: string, plan = { windows: [[10, 3]] as PlayWindow[], queue: true, betweenMs: 600 }) =>
        writePlan(name, plan);

    test("a plan round-trips by name", () => {
        make("gems");
        expect(findPlan("gems")?.plan.windows).toEqual([[10, 3]]);
        expect(listPlans().map((p) => p.name)).toEqual(["gems"]);
    });

    // The seeded track list sits beside the plan and matched the plan filename pattern, so it
    // was listed as a plan called "gems.tracks" whose own tracks file was missing.
    test("the .tracks.json sidecar is not itself a plan", () => {
        const created = make("gems");
        writeFileSync(created.path.replace(/\.json$/, ".tracks.json"), "[]");

        expect(listPlans().map((p) => p.name)).toEqual(["gems"]);
    });

    // The filename carries only a date, so two plans made the same afternoon tied and fell
    // back to alphabetical order — `play run` would pick "gems" over a just-made "nostalgia".
    test("same-day plans order by when they were written, newest first", async () => {
        make("gems");
        await Bun.sleep(10);
        make("nostalgia");

        expect(listPlans()[0]?.name).toBe("nostalgia");
        expect(newestPlan()?.name).toBe("nostalgia");
    });

    // The property that matters is that the plan file lands in the play directory. Separators
    // are stripped, and the date prefix means the name can never itself be "..", so a
    // traversal attempt becomes an ugly-but-harmless literal filename.
    test("a name that would escape the directory cannot", () => {
        const created = make("../../escape");
        expect(created.name).not.toContain("/");
        expect(dirname(created.path)).toBe(playDir());
        expect(existsSync(created.path)).toBe(true);
    });

    test("an unusable name is rejected rather than silently renamed", () => {
        expect(() => make("///")).toThrow("no usable characters");
    });

    test("loadPlan names the plan it could not find", () => {
        expect(() => loadPlan("nope")).toThrow('no plan named "nope"');
    });
});

describe("plan new help text", () => {
    // A usability tester guessed right but reported the text pointed the other way: `--top`
    // arrives from the shared reporting options as "how many rows to print", which in this
    // command decides how many tracks are seeded. Nothing else in the option list carries a
    // count, so a reader who believes the text has no fallback.
    const help = () => {
        const p = Bun.spawnSync(["bun", CLI, "play", "plan", "new", "--help"], {
            env: { ...process.env, NO_COLOR: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });

        return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
    };

    test("--top says it seeds tracks, not that it prints rows", () => {
        const text = help();
        expect(text).toContain("how many tracks to seed");
        expect(text).not.toContain("how many rows to print");
    });

    test("--from defines every source rather than just listing names", () => {
        const text = help();
        for (const source of SEED_SOURCES) {
            expect(text).toContain(`${source}:`);
        }
    });

    test("--seek/--play say they replace --windows", () => {
        expect(help()).toContain("replaces --windows");
    });
});

describe("journal resilience", () => {
    beforeEach(() => {
        rmSync(playDir(), { recursive: true, force: true });
    });

    afterAll(() => {
        rmSync(playDir(), { recursive: true, force: true });
    });

    // A run interrupted mid-append leaves a partial line. Throwing on it broke BOTH
    // `play status` and `--resume`, so the journal that exists to protect progress was
    // exactly what made progress unrecoverable.
    test("a torn final line does not cost the whole journal", () => {
        const tracksFile = join(tmpdir(), "x.json");
        appendJournal({ ts: "t", tracksFile, index: 0, uri: "u", name: "A", status: "ok" });
        appendJournal({ ts: "t", tracksFile, index: 1, uri: "u", name: "B", status: "ok" });
        appendFileSync(journalPath(), '{"ts":"t","tracksFi');

        const progress = progressFor(tracksFile);
        expect(progress.okIndexes.size).toBe(2);
    });

    test("clearing one tracks file leaves the others alone", () => {
        const a = join(tmpdir(), "a.json");
        const b = join(tmpdir(), "b.json");
        appendJournal({ ts: "t", tracksFile: a, index: 0, uri: "u", name: "A", status: "ok" });
        appendJournal({ ts: "t", tracksFile: b, index: 0, uri: "u", name: "B", status: "ok" });

        expect(clearJournal(a)).toBe(1);
        expect(progressFor(b).okIndexes.size).toBe(1);
    });
});

describe("FIND_PLAYER fiber traversal", () => {
    /** A root whose child has `n` siblings, with playerAPI on the last one. */
    const treeWithApiAtSibling = (n: number) => {
        const api = { play: () => {}, seekTo: () => {} };
        let chain: Record<string, unknown> | null = null;
        for (let i = n - 1; i >= 0; i--) {
            chain = { memoizedProps: i === n - 1 ? { playerAPI: api } : {}, child: null, sibling: chain };
        }

        return { api, root: { current: { memoizedProps: {}, child: chain, sibling: null } } };
    };

    const run = (root: unknown) => {
        const win: Record<string, unknown> = {
            __REACT_DEVTOOLS_GLOBAL_HOOK__: {
                renderers: new Map([[1, {}]]),
                getFiberRoots: () => new Set([root]),
            },
        };
        const previous = (globalThis as Record<string, unknown>).window;
        (globalThis as Record<string, unknown>).window = win;

        try {
            // biome-ignore lint/security/noGlobalEval: the payload is our own source, evaluated to test it
            return { result: eval(`(${FIND_PLAYER})`)(), win };
        } finally {
            (globalThis as Record<string, unknown>).window = previous;
        }
    };

    // Depth used to be spent on siblings too. On Liked Songs the rendered rows ARE the
    // sibling chain, so a library of a few thousand tracks exhausted the 3000 budget and the
    // player was reported missing on exactly the page this runs against.
    test("finds playerAPI past 3000 siblings", () => {
        const { api, root } = treeWithApiAtSibling(5000);
        const { result, win } = run(root);

        expect((result as { ok: boolean }).ok).toBe(true);
        expect(win.__playerAPI).toBe(api);
    });

    test("still finds it in a small tree", () => {
        const { api, root } = treeWithApiAtSibling(3);
        const { win } = run(root);

        expect(win.__playerAPI).toBe(api);
    });

    test("reports a miss rather than throwing when there is no player", () => {
        const root = { current: { memoizedProps: {}, child: null, sibling: null } };
        const { result } = run(root);

        expect((result as { ok: boolean; error: string }).ok).toBe(false);
        expect((result as { error: string }).error).toContain("not found");
    });
});
