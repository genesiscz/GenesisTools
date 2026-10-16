import { describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import {
    developerToolStatus,
    hostAppBundle,
    isDeveloperToolAllowed,
    SecurityAnalyzer,
} from "@app/doctor/analyzers/security";
import { writeCache } from "@app/doctor/lib/cache";
import { analysisDirFor, cacheFilePath } from "@app/doctor/lib/paths";
import type { AnalyzerContext, Finding } from "@app/doctor/lib/types";

describe("Developer Tools check", () => {
    it("keeps partial TCC reads unknown unless a readable database proves a grant", () => {
        const grant = [{ client: "com.example.host", auth_value: 2 }];
        expect(developerToolStatus([null, []], "com.example.host")).toBeNull();
        expect(developerToolStatus([[], null], "com.example.host")).toBeNull();
        expect(developerToolStatus([null, null], "com.example.host")).toBeNull();
        expect(developerToolStatus([null, grant], "com.example.host")).toBe(true);
        expect(developerToolStatus([grant, null], "com.example.host")).toBe(true);
        expect(developerToolStatus([[], []], "com.example.host")).toBe(false);
        expect(developerToolStatus([[], grant], "com.example.other")).toBe(false);
    });

    it("ignores cached host findings and scans again when the host changes", async () => {
        let host = "Editor";
        let scans = 0;
        class HostSecurityAnalyzer extends SecurityAnalyzer {
            protected async *run(): AsyncIterable<Finding> {
                scans++;
                yield {
                    id: "sec-developer-tools",
                    analyzerId: this.id,
                    title: `Developer Tools for ${host}`,
                    severity: host === "Terminal" ? "safe" : "cautious",
                    actions: [],
                };
            }
        }
        const analyzer = new HostSecurityAnalyzer();
        const runId = `doctor-security-test-${crypto.randomUUID()}`;
        const ctx: AnalyzerContext = {
            runId,
            opts: { thorough: false, fresh: false, dryRun: true },
            emit: () => {},
        };
        await writeCache(analyzer.id, {
            analyzerId: analyzer.id,
            findings: [
                {
                    id: "sec-developer-tools",
                    analyzerId: analyzer.id,
                    title: "stale Terminal",
                    severity: "safe",
                    actions: [],
                },
            ],
            durationMs: 0,
            error: null,
            fromCache: false,
            timestamp: new Date().toISOString(),
        });
        try {
            const editor = await analyzer.analyze(ctx);
            expect(editor.fromCache).toBe(false);
            expect(editor.findings[0].title).toBe("Developer Tools for Editor");
            expect(editor.findings[0].severity).toBe("cautious");
            host = "Terminal";
            const terminal = await analyzer.analyze(ctx);
            expect(terminal.fromCache).toBe(false);
            expect(terminal.findings[0].title).toBe("Developer Tools for Terminal");
            expect(terminal.findings[0].severity).toBe("safe");
            expect(scans).toBe(2);
        } finally {
            await rm(cacheFilePath(analyzer.id), { force: true });
            await rm(analysisDirFor(runId), { recursive: true, force: true });
        }
    });

    it("takes the outermost app up the process tree, not an app executable run as a CLI inside it", () => {
        const tree = [
            "/Users/example/Applications/GenesisTools.app/Contents/MacOS/GenesisTools",
            "/bin/zsh",
            "/Users/example/.bun/bin/bun",
            "/Applications/cmux.app/Contents/MacOS/cmux",
            "/sbin/launchd",
        ];
        expect(hostAppBundle(tree)).toBe("/Applications/cmux.app");
    });

    it("reads an editor app and gives nothing outside any app", () => {
        expect(hostAppBundle(["/Applications/Cursor.app/Contents/MacOS/Cursor"])).toBe("/Applications/Cursor.app");
        expect(hostAppBundle(["/bin/zsh", "/sbin/launchd"])).toBeNull();
    });

    it("allows only an allowed row for the same bundle id", () => {
        const rows = [
            { client: "com.apple.Terminal", auth_value: 2 },
            { client: "com.example.denied", auth_value: 0 },
        ];
        expect(isDeveloperToolAllowed(rows, "com.apple.Terminal")).toBe(true);
        expect(isDeveloperToolAllowed(rows, "com.example.denied")).toBe(false);
        expect(isDeveloperToolAllowed(rows, "com.cmuxterm.app")).toBe(false);
    });
});
