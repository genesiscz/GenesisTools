import { describe, expect, test } from "bun:test";
import { type EnvironmentSources, environmentMarkdown, gatherEnvironment } from "./environment";

const NOW = new Date("2026-11-09T12:00:00Z");

function sources(overrides: Partial<EnvironmentSources> = {}): EnvironmentSources {
    return {
        now: () => NOW,
        timeZone: "UTC",
        manifest: () => ({
            sourceCommit: "d9695acca14929f8325e22d1d0c32e341b91dbf1",
            sourceBranch: "feat/x",
            sourceDirty: true,
            sourceRoot: "/Users/alice/Projects/GenesisTools",
            builtAt: "2026-11-09T10:32:01.815Z",
        }),
        commitDate: (commit) => (commit.startsWith("d9695acca") ? "2026-11-09T09:00:00Z" : null),
        toolsHead: () => ({
            checkout: "/Users/alice/Projects/GenesisTools",
            head: "aaaabbbbccccddddeeee",
            branch: "feat/x",
        }),
        bunVersion: "1.3.13",
        macos: () => ({ version: "27.2", build: "26B118" }),
        machine: () => ({ chip: "Apple M4 Pro", arch: "arm64" }),
        grants: () => [
            { name: "Screen Recording", state: "granted" },
            { name: "Microphone", state: "granted" },
            { name: "Camera", state: "not asked yet" },
            { name: "Accessibility", state: "unknown (database not readable)" },
        ],
        recorder: () => ({ facePids: [61240], service: { pid: 5120, startedAt: "2026-11-09T11:00:00Z" } }),
        ...overrides,
    };
}

describe("gatherEnvironment", () => {
    test("names the build's commit with its age, the build time, the dirty flag and a tools checkout that differs", () => {
        const report = gatherEnvironment(sources());

        expect(report.app).toEqual({
            commit: "d9695acca14929f8325e22d1d0c32e341b91dbf1",
            shortCommit: "d9695acca149",
            commitDate: "2026-11-09T09:00:00Z",
            commitAge: "3 h old",
            branch: "feat/x",
            dirty: true,
            builtAt: "2026-11-09T10:32:01.815Z",
            builtAge: "1 h 27 min ago",
            checkout: "/Users/alice/Projects/GenesisTools",
        });
        expect(report.tools.differsFromApp).toBe(true);
        expect(report.tools.shortHead).toBe("aaaabbbbcccc");
    });

    test("renders the Environment section an issue and an agent read", () => {
        const markdown = environmentMarkdown(gatherEnvironment(sources()));

        expect(markdown).toContain(
            "- **GenesisTools build:** `d9695acca149+dirty` on `feat/x`, committed 2026-11-09 09:00 UTC (3 h old)"
        );
        expect(markdown).toContain("- **Built:** 2026-11-09 10:32 UTC (1 h 27 min ago)");
        expect(markdown).toContain("- **tools checkout:** `aaaabbbbcccc` on `feat/x` (differs from the app's build)");
        expect(markdown).toContain("- **Bun:** 1.3.13");
        expect(markdown).toContain("- **macOS:** 27.2 (26B118), Apple M4 Pro, arm64");
        expect(markdown).toContain(
            "- **Privacy grants:** Screen Recording granted, Microphone granted, Camera not asked yet, Accessibility unknown (database not readable)"
        );
        expect(markdown).toContain("- **Recorder:** face pid 61240, service pid 5120 (since 2026-11-09 11:00 UTC)");
    });

    test("a missing manifest, an unknown commit and no recorder still give a full section", () => {
        const report = gatherEnvironment(
            sources({
                manifest: () => null,
                commitDate: () => null,
                recorder: () => ({ facePids: [], service: null }),
            })
        );
        const markdown = environmentMarkdown(report);

        expect(report.app).toBeNull();
        expect(report.tools.differsFromApp).toBe(false);
        expect(markdown).toContain("- **GenesisTools build:** unknown (no ~/.genesis-tools/app/manifest.json)");
        expect(markdown).toContain("- **Recorder:** face not running, service not running");
    });
});
