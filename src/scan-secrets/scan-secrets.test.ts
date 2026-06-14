import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DETECTORS } from "./lib/detectors";
import { shannonEntropy } from "./lib/entropy";
import { maskSecret } from "./lib/mask";
import { formatHuman, toJsonResult } from "./lib/report";
import { scanContent } from "./lib/scan-content";
import { scanDirectory } from "./lib/scan-dir";
import { defaultScanConfig, type ScanResult } from "./lib/types";
import { walkFiles } from "./lib/walk";

describe("maskSecret", () => {
    test("keeps first 4 and last 4 with ellipsis for long secrets", () => {
        expect(maskSecret("AKIAIOSFODNN7EXAMPLE")).toBe("AKIA…MPLE");
    });

    test("fully masks secrets of 8 chars or fewer", () => {
        expect(maskSecret("short")).toBe("••••");
        expect(maskSecret("12345678")).toBe("••••");
    });

    test("never returns the full secret for a 9-char input", () => {
        const masked = maskSecret("123456789");
        expect(masked).not.toBe("123456789");
        expect(masked).toContain("…");
    });
});

describe("shannonEntropy", () => {
    test("returns 0 for a single repeated character", () => {
        expect(shannonEntropy("aaaaaaaa")).toBe(0);
    });

    test("a random-looking base64 string has high entropy", () => {
        expect(shannonEntropy("aB3xZ9qLkP2mWvT7")).toBeGreaterThan(3.5);
    });

    test("a low-variety string has lower entropy than a varied one", () => {
        expect(shannonEntropy("aaaabbbb")).toBeLessThan(shannonEntropy("abcdefgh"));
    });

    test("empty string is 0", () => {
        expect(shannonEntropy("")).toBe(0);
    });
});

describe("DETECTORS", () => {
    function namesMatching(content: string): string[] {
        const hits: string[] = [];
        for (const det of DETECTORS) {
            det.regex.lastIndex = 0;
            if (det.regex.test(content)) {
                hits.push(det.name);
            }
        }

        return hits;
    }

    test("aws access key id is detected", () => {
        expect(namesMatching('const k = "AKIAIOSFODNN7EXAMPLE"')).toContain("aws-access-key-id");
    });

    test("github personal token is detected", () => {
        const tok = `ghp_${"a".repeat(36)}`;
        expect(namesMatching(`token = "${tok}"`)).toContain("github-token");
    });

    test("slack bot token is detected", () => {
        // Synthetic placeholder shaped like xox[baprs]- + token chars; not a real token.
        expect(namesMatching('"xoxb-EXAMPLE-PLACEHOLDER-NOT-A-REAL-TOKEN"')).toContain("slack-token");
    });

    test("PEM private key header is detected", () => {
        expect(namesMatching("-----BEGIN RSA PRIVATE KEY-----")).toContain("private-key");
    });

    test("every detector regex carries the global flag", () => {
        for (const det of DETECTORS) {
            expect(det.regex.flags).toContain("g");
        }
    });
});

describe("scanContent", () => {
    const cfg = defaultScanConfig();

    test("reports an AWS key with correct line, masked, full secret absent", () => {
        const content = ["// header", 'const key = "AKIAIOSFODNN7EXAMPLE";'].join("\n");
        const findings = scanContent({ content, file: "a.ts", config: cfg });

        expect(findings).toHaveLength(1);
        const f = findings[0];
        expect(f.detector).toBe("aws-access-key-id");
        expect(f.line).toBe(2);
        expect(f.masked).toBe("AKIA…MPLE");
        expect(f.preview).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    test("preview masks the flagged span even when the value appears earlier on the line", () => {
        const secret = "aB3xZ9qLkP2mWvT7uYrEoNcDfGhJ";
        const content = `// example ${secret} -> apiKey = "${secret}"`;
        const findings = scanContent({ content, file: "a.ts", config: cfg });

        expect(findings).toHaveLength(1);
        const masked = maskSecret(secret);
        expect(findings[0].preview).toContain(`"${masked}"`);
    });

    test("an inline secret-scan:ignore comment suppresses findings on that line", () => {
        const content = 'const key = "AKIAIOSFODNN7EXAMPLE"; // secret-scan:ignore';
        expect(scanContent({ content, file: "a.ts", config: cfg })).toHaveLength(0);
    });

    test("an --ignore allowlist regex drops the matching finding", () => {
        const content = 'const key = "AKIAIOSFODNN7EXAMPLE";';
        const config = { ...cfg, ignorePatterns: [/AKIAIOSFODNN7EXAMPLE/] };
        expect(scanContent({ content, file: "a.ts", config })).toHaveLength(0);
    });

    test("prose with no assignment context yields zero generic/entropy findings", () => {
        const content =
            "The quick brown fox jumps over the lazy dog and then writes a very long sentence about nothing in particular.";
        expect(scanContent({ content, file: "a.md", config: cfg })).toHaveLength(0);
    });

    test("a high-entropy assigned base64 string is detected; entropy off suppresses it", () => {
        const content = 'apiKey = "aB3xZ9qLkP2mWvT7uYrEoNcDfGhJ"';
        expect(scanContent({ content, file: "a.ts", config: cfg }).length).toBeGreaterThan(0);

        const off = { ...cfg, disableEntropy: true };
        const offFindings = scanContent({ content, file: "a.ts", config: off });
        expect(offFindings.some((x) => x.detector === "high-entropy-base64")).toBe(false);
    });

    test("a low-entropy assigned string does NOT trip the entropy detector", () => {
        const content = 'apiKey = "aaaaaaaaaaaaaaaaaaaaaaaa"';
        const findings = scanContent({ content, file: "a.ts", config: cfg });
        expect(findings.some((x) => x.detector === "high-entropy-base64")).toBe(false);
    });

    test("de-duplicates overlapping detectors at the same span (one finding per span)", () => {
        const content = 'secret = "aB3xZ9qLkP2mWvT7uYrEoNcDfGhJ"';
        const findings = scanContent({ content, file: "a.ts", config: cfg });
        const spans = new Set(findings.map((f) => `${f.line}:${f.column}:${f.masked}`));
        expect(spans.size).toBe(findings.length);
    });
});

describe("walkFiles", () => {
    function makeRepo(): string {
        const dir = mkdtempSync(join(tmpdir(), "scan-secrets-walk-"));
        writeFileSync(join(dir, "keep.ts"), 'const x = "ok";');
        writeFileSync(join(dir, ".gitignore"), "ignored.ts\n");
        writeFileSync(join(dir, "ignored.ts"), 'const y = "ok";');
        mkdirSync(join(dir, "node_modules"));
        writeFileSync(join(dir, "node_modules", "dep.ts"), 'const z = "ok";');
        return dir;
    }

    test("respects .gitignore and always skips node_modules", () => {
        const dir = makeRepo();
        const files = walkFiles({ dir, respectGitignore: true, maxSizeKb: 1024 }).map((f) => f.relPath);

        expect(files).toContain("keep.ts");
        expect(files).not.toContain("ignored.ts");
        expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    });

    test("--no-gitignore includes the gitignored file but still skips node_modules", () => {
        const dir = makeRepo();
        const files = walkFiles({ dir, respectGitignore: false, maxSizeKb: 1024 }).map((f) => f.relPath);

        expect(files).toContain("ignored.ts");
        expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    });
});

describe("scanDirectory", () => {
    const NOW = new Date("2026-06-02T12:00:00.000Z");

    function makeRepo(): string {
        const dir = mkdtempSync(join(tmpdir(), "scan-secrets-dir-"));
        writeFileSync(join(dir, "leak.ts"), 'const key = "AKIAIOSFODNN7EXAMPLE";');
        writeFileSync(join(dir, "clean.ts"), 'const greeting = "hello world";');
        writeFileSync(join(dir, "blob.bin"), Buffer.from([0x00, 0x41, 0x4b, 0x49, 0x41]));
        return dir;
    }

    test("finds the AWS key, counts files, masks output, sets deterministic scannedAt", () => {
        const dir = makeRepo();
        const result = scanDirectory({
            dir,
            respectGitignore: true,
            maxSizeKb: 1024,
            ignorePatterns: [],
            disableEntropy: false,
            now: NOW,
        });

        expect(result.findingCount).toBe(1);
        expect(result.findings[0].detector).toBe("aws-access-key-id");
        expect(result.findings[0].masked).toBe("AKIA…MPLE");
        expect(result.scannedAt).toBe(NOW.toISOString());
        expect(result.scannedFiles).toBeGreaterThanOrEqual(2);
        expect(result.skips.some((s) => s.reason === "binary")).toBe(true);
    });

    test("a clean dir yields zero findings", () => {
        const dir = mkdtempSync(join(tmpdir(), "scan-secrets-clean-"));
        writeFileSync(join(dir, "ok.ts"), 'const a = "totally fine";');

        const result = scanDirectory({
            dir,
            respectGitignore: true,
            maxSizeKb: 1024,
            ignorePatterns: [],
            disableEntropy: false,
            now: NOW,
        });

        expect(result.findingCount).toBe(0);
    });
});

describe("report", () => {
    const result: ScanResult = {
        scannedFiles: 10,
        skippedFiles: 1,
        skips: [{ file: "x.bin", reason: "binary" }],
        findingCount: 1,
        findings: [
            {
                file: "a.ts",
                line: 14,
                column: 18,
                detector: "aws-access-key-id",
                masked: "AKIA…MPLE",
                preview: 'const key = "AKIA…MPLE"',
            },
        ],
        scannedAt: "2026-06-02T12:00:00.000Z",
    };

    test("human report includes file:line, detector, masked, and a count", () => {
        const text = formatHuman(result);
        expect(text).toContain("a.ts:14");
        expect(text).toContain("aws-access-key-id");
        expect(text).toContain("AKIA…MPLE");
        expect(text).toContain("1 finding");
        expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    test("json result is a plain serializable object with the finding payload", () => {
        const json = toJsonResult(result);
        expect(json.findingCount).toBe(1);
        expect(json.findings[0].detector).toBe("aws-access-key-id");
        expect(json.scannedAt).toBe("2026-06-02T12:00:00.000Z");
    });
});
