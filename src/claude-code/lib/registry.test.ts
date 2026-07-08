import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { fetchManifest, fetchPackument, hostPlatform, MAIN_PKG, platformPkg, resolveRange } from "./registry";

const FAKE_PACKUMENT = {
    versions: {
        "2.1.185": { version: "2.1.185", dist: { tarball: "https://x/185.tgz" } },
        "2.1.196": { version: "2.1.196", dist: { tarball: "https://x/196.tgz" } },
        "2.1.190": { version: "2.1.190", dist: { tarball: "https://x/190.tgz" } },
    },
    time: {
        "2.1.185": "2026-06-20T16:54:36.327Z",
        "2.1.190": "2026-06-24T00:00:00.000Z",
        "2.1.196": "2026-06-29T20:08:58.871Z",
    },
};

function fakeFetcher(body: unknown): typeof fetch {
    return (async () => new Response(SafeJSON.stringify(body) ?? "{}", { status: 200 })) as unknown as typeof fetch;
}

describe("registry", () => {
    test("fetchPackument returns sorted versions and time map", async () => {
        const p = await fetchPackument({ pkg: MAIN_PKG, fetcher: fakeFetcher(FAKE_PACKUMENT) });
        expect(p.versions).toEqual(["2.1.185", "2.1.190", "2.1.196"]);
        expect(p.time["2.1.196"]).toBe("2026-06-29T20:08:58.871Z");
    });

    test("resolveRange is inclusive and ordered", () => {
        const all = ["2.1.185", "2.1.190", "2.1.196", "2.1.197"];
        expect(resolveRange({ all, from: "2.1.185", to: "2.1.196" })).toEqual(["2.1.185", "2.1.190", "2.1.196"]);
    });

    test("resolveRange throws when an endpoint was never published", () => {
        expect(() => resolveRange({ all: ["2.1.185"], from: "2.1.188", to: "2.1.185" })).toThrow(/never published/);
    });

    test("fetchManifest returns dist + optionalDependencies", async () => {
        const m = await fetchManifest({
            pkg: MAIN_PKG,
            version: "2.1.185",
            fetcher: fakeFetcher({
                version: "2.1.185",
                dist: { tarball: "https://x/185.tgz", integrity: "sha512-abc" },
                optionalDependencies: { "@anthropic-ai/claude-code-darwin-arm64": "2.1.185" },
            }),
        });
        expect(m.dist.integrity).toBe("sha512-abc");
        expect(m.optionalDependencies?.["@anthropic-ai/claude-code-darwin-arm64"]).toBe("2.1.185");
    });

    test("platformPkg + hostPlatform", () => {
        expect(platformPkg("darwin-arm64")).toBe("@anthropic-ai/claude-code-darwin-arm64");
        expect(hostPlatform()).toMatch(/^(darwin|linux|win32)-(arm64|x64)$/);
    });
});
