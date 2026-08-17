/**
 * The parts of `harvest --auto` that do not need a browser: extracting the shipped browser
 * payloads and filling their token placeholders.
 *
 * Both are silent-failure shaped. If `page/*.ts` is reformatted so the payload no longer
 * starts where this expects, or a placeholder is renamed, the automated harvest would
 * install a helper that authenticates as nobody and fail 401 several steps later.
 */
import { describe, expect, test } from "bun:test";
import { autoHarvest, payload, preparedSetupGql } from "@app/spotify/lib/browser/harvest";
import { SafeJSON } from "@genesiscz/utils/json";

const tokens = { authorization: "Bearer test-access-token", clientToken: "test-client-token" };

describe("payload extraction", () => {
    test.each(["setupGql", "harvestLibrary"] as const)("%s yields an evaluable arrow function", (name) => {
        const src = payload(name);
        expect(src.startsWith("async () =>")).toBe(true);
        expect(src).not.toContain("BROWSER PAYLOAD");
    });
});

describe("preparedSetupGql", () => {
    test("substitutes both tokens", () => {
        const src = preparedSetupGql(tokens);
        expect(src).toContain("Bearer test-access-token");
        expect(src).toContain("test-client-token");
    });

    test("leaves no placeholder behind", () => {
        const src = preparedSetupGql(tokens);
        expect(src).not.toContain("<BEARER>");
        expect(src).not.toContain("<CLIENT_TOKEN>");
    });

    // The guard exists so a rename in page/setupGql.ts fails here rather than at runtime,
    // where the symptom is a 401 from a helper that looks correctly installed.
    test("the placeholders it depends on are still in the shipped payload", () => {
        const src = payload("setupGql");
        expect(src).toContain("Bearer <BEARER>");
        expect(src).toContain("<CLIENT_TOKEN>");
    });
});

/**
 * The success path, which a signed-in Spotify account is otherwise the only way to reach.
 *
 * The failure paths were verified against a real logged-out browser (they are what exposed
 * three wrong output-format assumptions). This covers what that browser could not: reading
 * the tokens out of a pathfinder request, installing the helper with them, and walking the
 * library. The fixtures are the REAL chrome-devtools-mcp output shapes.
 */
describe("autoHarvest success path", () => {
    const PAGES = "## Pages\n1: https://open.spotify.com/collection/tracks [selected]";
    const REQUESTS = [
        "## Network requests",
        "reqid=3 GET https://open.spotifycdn.com/cdn/build/web-player/vendor.js [200]",
        "reqid=7 POST https://api-partner.spotify.com/pathfinder/v2/query [200]",
    ].join("\n");
    const DETAIL = [
        "## Request https://api-partner.spotify.com/pathfinder/v2/query",
        "Status: 200",
        "### Request Headers",
        "- client-token:CLIENT123",
        "- authorization:Bearer ACCESS123",
    ].join("\n");

    const plain = (text: string) => ({ content: [{ type: "text", text }] });
    const fenced = (v: unknown) => ({
        content: [{ type: "text", text: `\`\`\`json\n${SafeJSON.stringify(v)}\n\`\`\`` }],
    });

    function fake() {
        const seen: string[] = [];

        const client = {
            callTool: async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
                const fn = typeof args?.function === "string" ? args.function : undefined;

                if (name === "list_pages") {
                    return plain(PAGES);
                }

                if (name === "select_page" || name === "navigate_page") {
                    return plain("ok");
                }

                if (name === "list_network_requests") {
                    return plain(REQUESTS);
                }

                if (name === "get_network_request") {
                    return plain(DETAIL);
                }

                if (name === "evaluate_script" && fn) {
                    // The sign-in probe runs first now, and it asks the PAGE, not the traffic.
                    if (fn.includes("now-playing-widget") && fn.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) {
                        return fenced({ ok: true });
                    }

                    seen.push(fn);

                    if (fn.includes("window.__H")) {
                        return fenced({ installed: true, probeStatus: 200, totalLikedTracks: 2 });
                    }

                    return fenced({
                        total: 2,
                        fetched: 2,
                        unique: 2,
                        requests: 1,
                        errors: [],
                        tracks: [
                            { uri: "spotify:track:a", name: "A", playcount: 100 },
                            { uri: "spotify:track:b", name: "B", playcount: 200 },
                        ],
                    });
                }

                return plain("");
            },
        } as unknown as import("@modelcontextprotocol/client").Client;

        return { seen, withClient: <T>(f: (c: typeof client) => Promise<T>) => f(client) };
    }

    test("reads the tokens, installs the helper with them, and returns the library", async () => {
        const f = fake();
        const result = await autoHarvest({
            browserUrl: "http://127.0.0.1:9222",
            onLog: () => {},
            withClient: f.withClient,
        });

        expect(result.unique).toBe(2);
        expect(result.tracks).toHaveLength(2);

        // The tokens from the network log must reach the installed helper verbatim; a
        // placeholder surviving here is the silent failure preparedSetupGql guards against.
        const setup = f.seen.find((s) => s.includes("window.__H"));
        expect(setup).toContain("Bearer ACCESS123");
        expect(setup).toContain("CLIENT123");
        expect(setup).not.toContain("<BEARER>");
    });

    test("a non-200 probe fails loudly instead of harvesting nothing", async () => {
        const f = fake();
        const client = {
            callTool: async (a: { name: string; arguments?: Record<string, unknown> }) => {
                const fn = typeof a.arguments?.function === "string" ? a.arguments.function : undefined;

                if (a.name === "list_pages") {
                    return plain(PAGES);
                }

                if (a.name === "list_network_requests") {
                    return plain(REQUESTS);
                }

                if (a.name === "get_network_request") {
                    return plain(DETAIL);
                }

                if (a.name === "evaluate_script" && fn?.includes("now-playing-widget")) {
                    return fenced({ ok: true });
                }

                if (a.name === "evaluate_script" && fn?.includes("window.__H")) {
                    return fenced({ installed: true, probeStatus: 401, hint: "token expired" });
                }

                return plain("ok");
            },
        } as unknown as import("@modelcontextprotocol/client").Client;

        await expect(
            autoHarvest({
                browserUrl: "http://127.0.0.1:9222",
                onLog: () => {},
                withClient: <T>(fn: (c: typeof client) => Promise<T>) => fn(client),
            })
        ).rejects.toThrow(/401|token expired/);
        expect(f.seen).toHaveLength(0);
    });
});
