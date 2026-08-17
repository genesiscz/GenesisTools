/**
 * The HTTP door. The CLI suite proves the reports; this proves the second door: the trust
 * boundary on the one write route, the parameter spelling the routes promise, and the report
 * dispatcher's name check.
 *
 * The handlers are exercised with plain `Request` objects rather than a running server, so the
 * guard is pinned by the test suite instead of by a browser sweep nobody repeats.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReportName } from "@app/spotify/lib/reports";
import { doctorReport } from "@app/spotify/lib/reports/pipeline";
import { profileDetail, profileList } from "@app/spotify/lib/reports/profiles";
import { apiHandler, boolParam, requireSameOrigin, strParam } from "@app/spotify/ui/server/api-utils";
import { parseAction, profileWrite } from "@app/spotify/ui/server/profile-write";
import { parseReportRequest, reportRead } from "@app/spotify/ui/server/report-read";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

const root = mkdtempSync(join(tmpdir(), "spotify-api-test-"));
const ORIGIN = "http://127.0.0.1:3075";
const snapshot = env.testing.snapshot();

beforeAll(() => {
    // Never the real registry: this file adds and removes profiles. The empty registry is
    // written up front so the first-run bootstrap does not import the developer's own profiles
    // into it, which would make the assertions depend on whose machine this runs on.
    env.testing.set("GENESIS_TOOLS_HOME", root);
    env.testing.set("SPOTIFY_CONFIG_PATH", join(root, "profiles.json"));
    env.testing.set("SPOTIFY_CACHE_DIR", join(root, "cache"));
    writeFileSync(join(root, "profiles.json"), SafeJSON.stringify({ profiles: [] }, { strict: true }));
});

afterAll(() => {
    env.testing.restore(snapshot);
    rmSync(root, { recursive: true, force: true });
});

function post(body: unknown, { origin, type = "application/json" }: { origin?: string; type?: string } = {}): Request {
    const headers: Record<string, string> = { "content-type": type };
    if (origin) {
        headers.origin = origin;
    }

    const payload = typeof body === "string" ? body : SafeJSON.stringify(body, { strict: true });

    return new Request(`${ORIGIN}/api/profiles`, { method: "POST", headers, body: payload });
}

describe("requireSameOrigin", () => {
    // A cross-site form POST is a "simple request": no preflight, response unreadable, but the
    // mutation happens. Requiring a JSON content type is what makes that shape impossible.
    test("refuses a request that is not JSON", () => {
        expect(() => requireSameOrigin(post({ action: "add", name: "x" }, { type: "text/plain" }))).toThrow(
            "requires a JSON request body"
        );
    });

    test("refuses a JSON request from another origin", () => {
        expect(() => requireSameOrigin(post({ action: "add", name: "x" }, { origin: "https://evil.example" }))).toThrow(
            "cross-origin request from https://evil.example refused"
        );
    });

    test("allows the dashboard's own request, with or without an Origin header", () => {
        expect(() => requireSameOrigin(post({ name: "x" }, { origin: ORIGIN }))).not.toThrow();
        expect(() => requireSameOrigin(post({ name: "x" }))).not.toThrow();
    });
});

describe("profileWrite", () => {
    test("a cross-origin write never reaches the registry", async () => {
        await expect(
            profileWrite(post({ action: "add", name: "attacker" }, { origin: "https://evil.example" }))
        ).rejects.toThrow("cross-origin");
        await expect(profileWrite(post({ action: "remove", name: "tester" }, { type: "text/plain" }))).rejects.toThrow(
            "JSON request body"
        );
    });

    // The negative control: the guard must not have broken the path the dashboard uses.
    test("a same-origin write reaches the registry", async () => {
        const res = await profileWrite(post({ action: "add", name: "tester", label: "Tester" }, { origin: ORIGIN }));
        expect(res.status).toBe(200);

        const listed = (await res.json()) as { profiles: { name: string; label: string }[] };
        expect(listed.profiles.map((p) => p.name)).toContain("tester");

        const removed = await profileWrite(post({ action: "remove", name: "tester" }, { origin: ORIGIN }));
        const after = (await removed.json()) as { profiles: { name: string }[] };
        expect(after.profiles.map((p) => p.name)).not.toContain("tester");
    });

    test("a nameless body is refused", async () => {
        await expect(profileWrite(post({ action: "add" }, { origin: ORIGIN }))).rejects.toThrow(
            'missing required "name"'
        );
    });

    test("a body that is not JSON at all is refused", async () => {
        await expect(profileWrite(post("not json", { origin: ORIGIN }))).rejects.toThrow(
            "could not parse the request body"
        );
    });

    // A typed `jsonBody<T>` is a compile-time assertion; at runtime the payload is whatever the
    // client sent. A non-string `tz` used to be persisted and then threw from `toLocaleString`
    // on every later report.
    test("a body that is not an object is refused", async () => {
        await expect(profileWrite(post([{ name: "tester" }], { origin: ORIGIN }))).rejects.toThrow(
            "must be a JSON object"
        );
        await expect(profileWrite(post("42", { origin: ORIGIN }))).rejects.toThrow("must be a JSON object");
    });

    test("a field that is not a string is refused", async () => {
        await expect(
            profileWrite(post({ action: "add", name: "tester", tz: ["Europe/Prague"] }, { origin: ORIGIN }))
        ).rejects.toThrow('"tz" must be a string');
        await expect(
            profileWrite(post({ action: "add", name: "tester", label: { a: 1 } }, { origin: ORIGIN }))
        ).rejects.toThrow('"label" must be a string');
        await expect(profileWrite(post({ action: "add", name: 7 }, { origin: ORIGIN }))).rejects.toThrow(
            '"name" must be a string'
        );
    });

    // An explicit null used to read as "field omitted", so `{ action: null }` fell through to
    // the "add" default and could overwrite an existing profile.
    test("an explicit null is not the same as an omitted field", async () => {
        await expect(profileWrite(post({ action: null, name: "tester" }, { origin: ORIGIN }))).rejects.toThrow(
            '"action" must be a string'
        );
        await expect(
            profileWrite(post({ action: "add", name: "tester", tz: null }, { origin: ORIGIN }))
        ).rejects.toThrow('"tz" must be a string');
    });

    // The name lands in the history cache filename, so a separator would read and write
    // outside the cache directory.
    test("a name that would escape the cache directory is refused", async () => {
        for (const name of ["../outside", "a/b", "a\\b", "..", "x..y"]) {
            await expect(profileWrite(post({ action: "add", name }, { origin: ORIGIN }))).rejects.toThrow(
                "invalid profile name"
            );
        }
    });

    test("an unknown timezone is refused before it reaches the registry", async () => {
        await expect(
            profileWrite(post({ action: "add", name: "tester", tz: "Mars/Olympus" }, { origin: ORIGIN }))
        ).rejects.toThrow('unknown timezone "Mars/Olympus"');

        const listed = await profileWrite(
            post({ action: "add", name: "tz-ok", tz: "America/New_York" }, { origin: ORIGIN })
        );
        const after = (await listed.json()) as { profiles: { name: string; timezone: string }[] };
        expect(after.profiles.find((p) => p.name === "tz-ok")?.timezone).toBe("America/New_York");
    });
});

describe("diagnostics do not mutate", () => {
    // The house rule: a command named `doctor` reports on durable state, it never creates it.
    // `loadRegistry()` persists a first-run bootstrap, so reading through it meant that running
    // `doctor` on a machine with a discoverable export left a profiles.json behind.
    test("reading a missing registry never writes one", () => {
        const dir = mkdtempSync(join(tmpdir(), "spotify-peek-test-"));
        const path = join(dir, "profiles.json");
        env.testing.set("SPOTIFY_CONFIG_PATH", path);

        try {
            doctorReport();
            profileList(path);
            // `profile show` too: the first fix covered doctor and list, and show was found
            // still persisting through `getProfile`. The read path itself cannot write now, so
            // this asserts the property rather than a list of exempted callers.
            try {
                profileDetail();
            } catch (err) {
                // No profile to show on a machine with nothing discoverable, which is fine —
                // what matters is that trying did not create the file.
                expect(err).toBeInstanceOf(Error);
            }

            expect(existsSync(path)).toBe(false);
        } finally {
            env.testing.set("SPOTIFY_CONFIG_PATH", join(root, "profiles.json"));
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("apiHandler error classification", () => {
    const call = (thrown: unknown) =>
        apiHandler(() => {
            throw thrown;
        })({ request: new Request(`${ORIGIN}/api/x`) });

    // A report's own error is a sentence written for a person and is the caller's problem; a
    // missing file or a programming error is not, and 400 would blame the wrong party.
    test("a report error is a 400 carrying its message", async () => {
        const res = await call(new Error('no profile "kaja". Known: me'));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'no profile "kaja". Known: me' });
    });

    test("an operational failure is a 500 with nothing internal in it", async () => {
        const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        for (const err of [enoent, new SyntaxError("Unexpected token"), new TypeError("x is not a function")]) {
            const res = await call(err);
            expect(res.status).toBe(500);
            expect(await res.json()).toEqual({ error: "the server could not complete that request" });
        }
    });
});

describe("parseAction", () => {
    // Defaulting anything unrecognised to "add" meant `"delete"` created a profile and got a 200.
    test("rejects an action it does not know", () => {
        expect(() => parseAction("delete")).toThrow('unknown action "delete"');
        expect(() => parseAction("__proto__")).toThrow("unknown action");
    });

    test("defaults to add, and passes the three it knows", () => {
        expect(parseAction(undefined)).toBe("add");
        expect(parseAction("use")).toBe("use");
        expect(parseAction("remove")).toBe("remove");
    });
});

describe("the report route", () => {
    const get = (path: string) => new Request(`${ORIGIN}${path}`);

    test("an unknown report name is a 404 with a JSON error", async () => {
        const res = reportRead(get("/api/report/nonsense"), "nonsense");
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'unknown report "nonsense"' });
    });

    // `name in REPORTS` used to resolve these through the prototype chain and reach the
    // dispatcher with a function that is not a report.
    test("an inherited property is not a report name", async () => {
        for (const name of ["constructor", "toString", "__proto__"]) {
            expect(reportRead(get(`/api/report/${name}`), name).status).toBe(404);
        }
    });

    // The point of the door: the URL is the command line. This asserts the mapping itself,
    // rather than trusting that every parameter was spelled correctly in the route file.
    test("maps query parameters onto report options, in either spelling", () => {
        const parsed = parseReportRequest(
            new URLSearchParams("profile=me&kind=artists&min-ms=45000&all-plays&quiet-months=6&trend&top=15")
        );
        expect(parsed.profile).toBe("me");
        expect(parsed.kind).toBe("artists");
        expect(parsed.minMs).toBe("45000");
        expect(parsed.allPlays).toBe(true);
        expect(parsed.quietMonths).toBe("6");
        expect(parsed.trend).toBe(true);
        expect(parsed.top).toBe("15");
        expect(parsed.genre).toBeUndefined();
    });

    test("an absent parameter stays undefined rather than becoming an empty string", () => {
        const parsed = parseReportRequest(new URLSearchParams(""));
        expect(Object.values(parsed).every((v) => v === undefined)).toBe(true);
    });
});

describe("query parameters", () => {
    // The routes promise that a URL is the command line, so both spellings must work.
    test("accept the CLI's flag spelling as well as camelCase", () => {
        const params = new URLSearchParams("min-ms=1000&quiet-months=6&all-plays=1");
        expect(strParam(params, "minMs")).toBe("1000");
        expect(strParam(params, "quietMonths")).toBe("6");
        expect(boolParam(params, "allPlays")).toBe(true);

        const camel = new URLSearchParams("minMs=2000&allPlays=0");
        expect(strParam(camel, "minMs")).toBe("2000");
        expect(boolParam(camel, "allPlays")).toBe(false);
    });

    test("a valueless flag reads as true, and an absent one as undefined", () => {
        expect(boolParam(new URLSearchParams("trend"), "trend")).toBe(true);
        expect(boolParam(new URLSearchParams(""), "trend")).toBeUndefined();
        expect(strParam(new URLSearchParams("artist="), "artist")).toBeUndefined();
    });
});

describe("isReportName", () => {
    test("accepts a real report and rejects everything else", () => {
        expect(isReportName("summary")).toBe(true);
        expect(isReportName("top")).toBe(true);
        expect(isReportName("nonsense")).toBe(false);
    });

    // `name in REPORTS` used to resolve these through the prototype chain.
    test("rejects inherited object properties", () => {
        expect(isReportName("constructor")).toBe(false);
        expect(isReportName("toString")).toBe(false);
        expect(isReportName("__proto__")).toBe(false);
    });
});

/**
 * Every report the CLI changed must still come back through the HTTP door.
 *
 * The door had coverage for exactly two reports, `summary` and `top`, while a single session
 * changed the internals of `dna`, `compat`, `streaks` and `shift`. "One core, three thin
 * doors" only holds if the doors are actually opened, and a report that throws here is a 500
 * on a dashboard page rather than a failing test.
 */
describe("the report route serves real data", () => {
    const historyDir = join(root, "http-history");

    beforeAll(() => {
        mkdirSync(historyDir, { recursive: true });
        // Two years so `shift` has two windows and `dna`'s loyalty axis has something to see.
        const rows = Array.from({ length: 240 }, (_, i) => ({
            ts: `${2024 + (i % 2)}-0${(i % 9) + 1}-1${i % 10}T1${i % 10}:00:00Z`,
            ms_played: 200_000,
            spotify_track_uri: `spotify:track:t${i % 40}`,
            master_metadata_track_name: `Song ${i % 40}`,
            master_metadata_album_artist_name: `Artist ${i % 12}`,
            master_metadata_album_album_name: `Album ${i % 15}`,
            platform: "osx",
            conn_country: "CZ",
            reason_start: "clickrow",
            reason_end: "trackdone",
        }));
        writeFileSync(join(historyDir, "Streaming_History_Audio_2024.json"), SafeJSON.stringify(rows));
        writeFileSync(
            join(root, "profiles.json"),
            SafeJSON.stringify({
                profiles: [
                    { name: "http", label: "HTTP", historyDir, timezone: "Europe/Prague", addedAt: "2026-01-01" },
                ],
            })
        );
    });

    // Through `apiHandler`, exactly as `routes/api/report.$name.ts` composes it. Calling
    // `reportRead` bare would skip the layer that turns a caller error into a 400, and the
    // test would then be asserting a composition the app does not use.
    const call = async (name: string, query = "profile=http") => {
        const request = new Request(`${ORIGIN}/api/report/${name}?${query}`);
        const res = await apiHandler(() => reportRead(request, name))({ request });

        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    test.each([
        "summary",
        "top",
        "dna",
        "streaks",
        "clock",
        "timeline",
        "behavior",
        "seasons",
    ])("%s answers 200 with a head", async (name) => {
        const { status, body } = await call(name);
        expect(status).toBe(200);
        expect(body.head).toBeDefined();
    });

    // `axes()` was resplit into three play sets this session; a mismatched call site would
    // throw here and show as a broken dashboard page rather than a red test.
    test("dna returns its eight axes, each a ratio in [0,1]", async () => {
        const { body } = await call("dna");
        const axes = body.axes as { axis: string; value: number }[];
        expect(axes).toHaveLength(8);
        for (const a of axes) {
            expect(a.value).toBeGreaterThanOrEqual(0);
            // A ratio, within floating-point reach of 1: an axis that divides a count by
            // itself lands on 1.0000000000000004, which renders as 100% and is not a defect.
            expect(a.value).toBeLessThanOrEqual(1 + 1e-9);
        }
    });

    // maxOf() replaced Math.max(...map.values()) in the compat path this session.
    test("compat against the same profile scores every component it can", async () => {
        const { status, body } = await call("compat", "a=http&b=http&profile=http");
        expect(status).toBe(200);

        const components = body.components as { name: string; score: number }[];
        // Identical input, so every component that HAS data must be a perfect match. The
        // genre component scores 0 here because the fixture has no enrichment, which is why
        // the blended figure is below 1 and asserting 1.0 would encode a wrong expectation.
        const measurable = components.filter((c) => c.name !== "genre profile");
        for (const c of measurable) {
            expect(c.score).toBeCloseTo(1, 5);
        }

        expect(body.compatibility as number).toBeGreaterThan(0);
    });

    test("a bad window is a caller error, not a 500", async () => {
        const { status } = await call("summary", "profile=http&since=2025-13-01");
        expect(status).toBe(400);
    });
});
