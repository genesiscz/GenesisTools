import { describe, expect, test } from "bun:test";
import {
    type EnvironmentSources,
    environmentMarkdown,
    gatherEnvironment,
    issueEnvironmentValues,
    parseIssueTemplate,
    readBugTemplate,
} from "./environment";
import { gatherTriage, processLabel, type TriageSources, triageDocument, triageMarkdown } from "./triage";

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
        machine: () => ({ chip: "Apple M4 Pro", model: "Mac16,7", memoryGb: 48, arch: "arm64" }),
        grants: () => [
            { name: "Screen Recording", state: "granted" },
            { name: "Microphone", state: "granted" },
            { name: "Camera", state: "not asked yet" },
            { name: "Accessibility", state: "unknown (database not readable)" },
        ],
        recorder: () => ({ facePids: [61240], service: { pid: 5120, startedAt: "2026-11-09T11:00:00Z" } }),
        caller: () => ({ agent: "claude-code", sessionId: "s-1", others: ["codex t-2"] }),
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
        expect(markdown).toContain("- **macOS:** 27.2 (26B118)");
        expect(markdown).toContain("- **Mac:** Apple M4 Pro, Mac16,7, 48 GB, arm64");
        expect(markdown).toContain("- **Calling agent:** claude-code session s-1 (also codex t-2)");
        expect(markdown).toContain(
            "- **Privacy grants of GenesisTools.app:** Screen Recording granted, Microphone granted, Camera not asked yet, Accessibility unknown (database not readable)"
        );
        expect(markdown).toContain("- **Recorder:** face pid 61240, service pid 5120 (since 2026-11-09 11:00 UTC)");
    });

    test("a missing manifest, an unknown commit and no recorder still give a full section", () => {
        const report = gatherEnvironment(
            sources({
                manifest: () => null,
                commitDate: () => null,
                recorder: () => ({ facePids: [], service: null }),
                caller: () => null,
            })
        );
        const markdown = environmentMarkdown(report);

        expect(report.app).toBeNull();
        expect(report.tools.differsFromApp).toBe(false);
        expect(markdown).toContain("- **GenesisTools build:** unknown (no ~/.genesis-tools/app/manifest.json)");
        expect(markdown).toContain("- **Recorder:** face not running, service not running");
        expect(markdown).not.toContain("Calling agent");
    });
});

describe("issue template fields", () => {
    const TEMPLATE = `name: Bug report
body:
  - type: markdown
    attributes:
      value: Thanks
  - type: checkboxes
    id: checks
    attributes:
      label: Before you submit
  - type: textarea
    id: what-happened
    attributes:
      label: What happened
  - type: textarea
    id: actual
    attributes:
      label: Actual (error + log)
      render: shell
  - type: input
    id: commit
    attributes:
      label: GenesisTools commit and its age
  - type: textarea
    id: permissions
    attributes:
      label: Privacy grants
      render: shell
`;

    test("reads the form's fields in order with their labels, leaving out markdown blocks", () => {
        expect(parseIssueTemplate(TEMPLATE)).toEqual([
            { id: "checks", label: "Before you submit", type: "checkboxes", render: null },
            { id: "what-happened", label: "What happened", type: "textarea", render: null },
            { id: "actual", label: "Actual (error + log)", type: "textarea", render: "shell" },
            { id: "commit", label: "GenesisTools commit and its age", type: "input", render: null },
            { id: "permissions", label: "Privacy grants", type: "textarea", render: "shell" },
        ]);
        expect(parseIssueTemplate("not: [yaml")).toEqual([]);
    });

    test("fills the environment fields the bug form asks for", () => {
        const values = issueEnvironmentValues(gatherEnvironment(sources()));

        expect(values.commit).toBe("d9695acca149+dirty, 3 h old");
        expect(values.branch).toBe("feat/x");
        expect(values.macos).toBe("27.2 (26B118)");
        expect(values.chip).toBe("Apple M4 Pro, Mac16,7, 48 GB, arm64");
        expect(values.agent).toBe("claude-code session s-1 (also codex t-2)");
        expect(values.bun).toBe("1.3.13");
        expect(values.permissions).toBe(
            "Screen Recording: granted\nMicrophone: granted\nCamera: not asked yet\nAccessibility: unknown (database not readable)"
        );
        expect(values["app-build"]).toContain("built 2026-11-09 10:32 UTC (1 h 27 min ago)");
        expect(values["app-build"]).toContain("tools checkout aaaabbbbcccc on feat/x differs from the app's build");
        expect(values["app-build"]).toContain("recorder: face pid 61240, service pid 5120");
    });

    test("every environment answer names a field of the checkout's real bug form", () => {
        const template = readBugTemplate();
        const ids = new Set(template.fields.map((field) => field.id));

        const keys = Object.keys(issueEnvironmentValues(gatherEnvironment(sources())));

        expect(template.path).not.toBeNull();
        expect(keys.length).toBeGreaterThan(0);
        expect(keys.filter((key) => !ids.has(key))).toEqual([]);
    });
});

describe("triage", () => {
    const environment = gatherEnvironment({
        now: () => new Date("2026-11-10T18:00:00Z"),
        timeZone: "Europe/Prague",
        manifest: () => null,
        commitDate: () => null,
        toolsHead: () => ({ checkout: "/repo", head: null, branch: null }),
        bunVersion: "1.3.13",
        macos: () => ({ version: "27.2", build: "26B1" }),
        machine: () => ({ chip: "Apple M4", model: null, memoryGb: null, arch: "arm64" }),
        grants: () => [],
        recorder: () => ({ facePids: [], service: null }),
        caller: () => null,
    });
    const sources = (): TriageSources => ({
        now: () => new Date("2026-11-10T18:00:00Z"),
        environment: () => environment,
        load: () => ({ one: 40, five: 30, fifteen: 20, cores: 16 }),
        memory: () => ({ totalGb: 64, freeGb: 1.5, pressure: "warning", swapUsedGb: 5.4 }),
        processes: () => [
            {
                pid: 10,
                name: "ffmpeg",
                command: "/opt/bin/ffmpeg -i in.mov --token s3cret out.mp4",
                cpuPercent: 240,
                rssBytes: 3 * 1024 ** 3,
                startMs: null,
            },
            {
                pid: 11,
                name: "bun",
                command:
                    "/Users/alice/.bun/bin/bun --preload /repo/src/utils/bun/preload.ts /repo/src/hub/index.ts serve",
                cpuPercent: 80,
                rssBytes: 600 * 1024 ** 2,
                startMs: null,
            },
            {
                pid: 12,
                name: "GenesisTools",
                command: "/Users/alice/Applications/GenesisTools.app/Contents/MacOS/GenesisTools --hub --mode inbox",
                cpuPercent: 3,
                rssBytes: 200 * 1024 ** 2,
                startMs: Date.parse("2026-11-10T17:50:00Z"),
            },
        ],
        hubServer: async () => ({ state: "busy" }),
        failures: () => [
            { at: "2026-11-10T17:58:00Z", command: "ai sessions tail", exit: 1, message: "no such session" },
        ],
        perfLogTail: () => [
            "[18:59:00.000] hub.sessions.list 12.0ms",
            "[18:59:10.000] mark call t=abc via=server-timeout pid=1 ms=31044 exit=-1 argv=ai sessions tail",
            "[18:59:20.000] mark main-stall recovered after 600ms load=40.0 recent=[load-top load=40: 10 240% ffmpeg]",
        ],
        crashes: () => [],
        disk: () => {
            throw new Error("statfs refused");
        },
    });

    test("names a process by its program and script, never by its whole command line", () => {
        expect(processLabel("ffmpeg", "/opt/bin/ffmpeg -i in.mov --token s3cret out.mp4")).toBe("ffmpeg");
        expect(processLabel("bun", "/Users/alice/.bun/bin/bun --preload /repo/p.ts /repo/src/hub/index.ts serve")).toBe(
            "bun hub/index.ts"
        );
        expect(processLabel("launchd", null)).toBe("launchd");
    });

    test("reports every part, and a part that fails does not fail the report", async () => {
        const report = await gatherTriage(sources());
        expect(report.disk).toEqual({ ok: false, error: "statfs refused" });
        expect(report.processes.ok && report.processes.value.topCpu.map((entry) => entry.name)).toEqual([
            "ffmpeg",
            "bun hub/index.ts",
            "GenesisTools",
        ]);
        expect(report.faces.ok && report.faces.value).toEqual([
            { face: "--hub", pid: 12, startedAt: "2026-11-10T17:50:00.000Z" },
        ]);
        expect(report.slowCalls.ok && report.slowCalls.value).toEqual([
            "[18:59:10.000] mark call t=abc via=server-timeout pid=1 ms=31044 exit=-1 argv=ai sessions tail",
            "[18:59:20.000] mark main-stall recovered after 600ms load=40.0",
        ]);

        const markdown = triageMarkdown(report);
        expect(markdown).toContain("- **Load:** 40.0 30.0 20.0 on 16 cores, overloaded");
        expect(markdown).toContain("- **Memory:** 1.5 GB unused of 64 GB, pressure warning, swap 5.4 GB used");
        expect(markdown).toContain("- **Top CPU:** ffmpeg 240% (pid 10), bun hub/index.ts 80% (pid 11)");
        expect(markdown).toContain("- **Hub server:** running, but it did not answer in 1500 ms");
        expect(markdown).toContain("- **App faces:** --hub pid 12 (since 18:50:00)");
        expect(markdown).toContain("- **Disk:** not read (statfs refused)");
        expect(markdown).toContain("18:58:00 `tools ai sessions tail` exit 1: no such session");
        expect(markdown).not.toContain("s3cret");
        expect(triageDocument(report)).toContain("#### State of this Mac at 19:00:00");
    });
});
