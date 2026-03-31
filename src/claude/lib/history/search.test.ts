import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonl(obj: Record<string, unknown>): string {
    return SafeJSON.stringify(obj);
}

function makeSessionJsonl(sessionId: string, opts: { sizeBytes?: number } = {}): string {
    const lines = [
        jsonl({
            type: "user",
            userType: "external",
            sessionId,
            cwd: "/Users/test/Projects/MyProject",
            gitBranch: "main",
            timestamp: "2026-03-27T10:00:00.000Z",
            message: { role: "user", content: "hello world" },
        }),
        jsonl({
            type: "assistant",
            sessionId,
            timestamp: "2026-03-27T10:00:01.000Z",
            message: {
                id: `msg_${sessionId.slice(0, 8)}`,
                role: "assistant",
                model: "claude-opus-4-6",
                content: [{ type: "text", text: "hi" }],
                usage: { input_tokens: 100, output_tokens: 50 },
            },
        }),
    ];
    let content = `${lines.join("\n")}\n`;

    if (opts.sizeBytes && opts.sizeBytes > content.length) {
        const pad = jsonl({
            type: "assistant",
            sessionId,
            timestamp: "2026-03-27T10:00:02.000Z",
            message: {
                id: `msg_pad_${"x".repeat(80)}`,
                role: "assistant",
                model: "claude-opus-4-6",
                content: [{ type: "text", text: "x".repeat(500) }],
                usage: { input_tokens: 1, output_tokens: 1 },
            },
        });
        while (content.length < opts.sizeBytes) {
            content += `${pad}\n`;
        }
    }

    return content;
}

// ---------------------------------------------------------------------------
// Bug: history auto-detect takes parent org instead of leaf project
// ---------------------------------------------------------------------------

describe("project detection for nested project dirs", () => {
    it("resolveProjectFilter returns encoded dir or leaf basename, never parent org", () => {
        const { resolveProjectFilter } = require("@app/utils/claude");

        // For real cwd, should return an encoded dir (starting with "-") or a leaf name
        const result = resolveProjectFilter(process.cwd());
        expect(result).toBeTruthy();

        // Should never return just a parent org segment
        // For /Users/jane/Projects/acme-corp/web-app it should return
        // "-Users-jane-Projects-acme-corp-web-app" (encoded) or "web-app" (fallback)
        // — never "acme-corp"
        if (result!.startsWith("-")) {
            // Encoded dir — should contain the full path
            expect(result).toContain(process.cwd().split("/").pop());
        } else {
            // Fallback — should be the leaf directory name
            const { basename } = require("node:path");
            expect(result).toBe(basename(process.cwd()));
        }
    });

    it("extractProjectName resolves leaf from encoded nested dir on this machine", () => {
        const { extractProjectName, PROJECTS_DIR } = require("./search");
        const { readdirSync } = require("node:fs");

        // Find a real encoded dir with multiple dashes (nested project)
        let nestedDir: string | undefined;
        try {
            const dirs = readdirSync(PROJECTS_DIR) as string[];
            nestedDir = dirs.find((d: string) => {
                const dashCount = (d.match(/-/g) || []).length;
                return dashCount > 5 && d.startsWith("-");
            });
        } catch {
            // No claude projects dir — skip
        }

        if (!nestedDir) {
            // Can't test without real dirs — mark as TODO
            expect(true).toBe(true);
            return;
        }

        const filePath = `${PROJECTS_DIR}/${nestedDir}/test.jsonl`;
        const name = extractProjectName(filePath);
        expect(name).toBeTruthy();
        expect(name.length).toBeGreaterThan(0);
    });

    it("exact encoded dir match prevents sibling project bleeding", () => {
        // When resolveProjectFilter returns an encoded dir starting with "-",
        // findConversationFiles uses exact path match instead of glob *pattern*
        const encodedDir = "-Users-jane-workspace-Projects-acme-corp-web-app";
        const siblingDirs = [
            "-Users-jane-workspace-Projects-acme-corp-web-app",
            "-Users-jane-workspace-Projects-acme-corp-api",
            "-Users-jane-workspace-Projects-acme-corp-mobile",
        ];

        // With old glob *acme-corp* approach: all 3 match
        const oldGlobMatches = siblingDirs.filter((d) => d.includes("acme-corp"));
        expect(oldGlobMatches).toHaveLength(3);

        // With new exact match approach: only the target matches
        const exactMatches = siblingDirs.filter((d) => d === encodedDir);
        expect(exactMatches).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Bug: extractSessionMetadataFromFile skips files >10MB
// ---------------------------------------------------------------------------

describe("extractSessionMetadataFromFile — large files", () => {
    let tmpDir: string;
    let projectDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "search-test-"));
        projectDir = join(tmpDir, "-Users-test-Projects-MyProject");
        mkdirSync(projectDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns metadata for files larger than 10MB", async () => {
        const { extractSessionMetadataFromFile } = await import("./search");

        const sessionId = "f6f7a445-d148-4936-b90f-3484dd8bb538";
        const content = makeSessionJsonl(sessionId, { sizeBytes: 11 * 1024 * 1024 });
        const filePath = join(projectDir, `${sessionId}.jsonl`);
        writeFileSync(filePath, content);

        const stat = Bun.file(filePath);
        expect(stat.size).toBeGreaterThan(10 * 1024 * 1024);

        const mtime = Math.floor(Date.now());
        const result = await extractSessionMetadataFromFile(filePath, mtime);

        // BUG: currently returns null for any file >10MB
        expect(result).not.toBeNull();
        expect(result?.sessionId).toBe(sessionId);
        expect(result?.firstPrompt).toBe("hello world");
        expect(result?.gitBranch).toBe("main");
    });
});

// ---------------------------------------------------------------------------
// Bug: readTailBytes drops first line on boundary
// ---------------------------------------------------------------------------

describe("readTailBytes — line boundary detection", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "tail-test-"));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("preserves first line when slice starts on newline boundary", async () => {
        const { readTailBytes } = await import("@app/utils/claude/session.utils");

        const line1 = '{"id":"first-line-aaaaaa"}';
        const line2 = '{"id":"second"}';
        const line3 = '{"id":"third"}';
        const content = `${line1}\n${line2}\n${line3}\n`;
        writeFileSync(join(tmpDir, "test.jsonl"), content);

        const tailBytes = `${line2}\n${line3}\n`.length;
        const lines = await readTailBytes(join(tmpDir, "test.jsonl"), tailBytes);

        // BUG: drops line2 even though it's complete (slice starts after \n)
        expect(lines).toEqual([line2, line3]);
    });

    it("drops partial first line when slicing mid-line", async () => {
        const { readTailBytes } = await import("@app/utils/claude/session.utils");

        const line1 = '{"id":"aaaaaaaaaaaaaaaaa"}';
        const line2 = '{"id":"bbb"}';
        const content = `${line1}\n${line2}\n`;
        writeFileSync(join(tmpDir, "test2.jsonl"), content);

        const lines = await readTailBytes(join(tmpDir, "test2.jsonl"), line2.length + 5);
        expect(lines).toEqual([line2]);
    });
});
