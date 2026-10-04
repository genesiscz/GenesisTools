import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DETECTORS } from "@app/secrets/lib/detectors";
import { shannonEntropy } from "@app/secrets/lib/entropy";
import { maskSecret } from "@app/secrets/lib/mask";
import { isPlaceholderSecret } from "@app/secrets/lib/placeholders";
import { formatHuman, toJsonResult } from "@app/secrets/lib/report";
import { scanContent } from "@app/secrets/lib/scan-content";
import { scanDirectory } from "@app/secrets/lib/scan-dir";
import { defaultScanConfig, type ScanResult } from "@app/secrets/lib/types";
import { walkFiles } from "@app/secrets/lib/walk";

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

    // Regression test: #451 — value-based detectors for providers GenesisTools users leak most.
    test("an OpenAI key carrying the T3BlbkFJ marker is detected", () => {
        const key = `sk-proj-${"a".repeat(48)}T3BlbkFJ${"b".repeat(48)}`;
        expect(namesMatching(`export const openai = "${key}";`)).toContain("openai-key");
    });

    test("an OpenAI key in the newer markerless 100+ char form is detected", () => {
        const key = `sk-proj-${"c".repeat(110)}`;
        expect(namesMatching(`export const openai = "${key}";`)).toContain("openai-key");
    });

    test("a short sk-proj- value with no marker and under 100 chars is NOT a detected OpenAI key", () => {
        const key = `sk-proj-${"d".repeat(40)}`;
        expect(namesMatching(`export const openai = "${key}";`)).not.toContain("openai-key");
    });

    test("an Anthropic key is detected", () => {
        const key = `sk-ant-api03-${"e".repeat(85)}`;
        expect(namesMatching(`export const anthropic = "${key}";`)).toContain("anthropic-key");
    });

    test("a Stripe live key is detected", () => {
        const key = `sk_live_${"f".repeat(24)}`;
        expect(namesMatching(`export const stripe = "${key}";`)).toContain("stripe-key");
    });

    test("an OpenRouter key is detected", () => {
        const key = `sk-or-v1-${"a1b2c3d4".repeat(8)}`;
        expect(namesMatching(`export const openrouter = "${key}";`)).toContain("openrouter-key");
    });

    test("a Google API key is detected", () => {
        const key = `AIza${"g".repeat(35)}`;
        expect(namesMatching(`export const google = "${key}";`)).toContain("google-api-key");
    });

    test("a GitHub fine-grained token is detected", () => {
        const key = `github_pat_${"h".repeat(82)}`;
        expect(namesMatching(`export const gh = "${key}";`)).toContain("github-fine-grained");
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

describe("dotenv-assignment", () => {
    const cfg = defaultScanConfig();

    // Regression test: #451 — a standard unquoted .env line is invisible today because
    // generic-assignment and high-entropy-base64 both require a quoted value.
    test("an unquoted dotenv line with a secret-ish identifier is flagged", () => {
        const content = "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        const findings = scanContent({ content, file: ".env", config: cfg });

        expect(findings).toHaveLength(1);
        expect(findings[0].detector).toBe("dotenv-assignment");
    });

    test("a trailing # comment is stripped from the captured value", () => {
        const content = "API_KEY=abcdefghijklmnop # trailing comment";
        const findings = scanContent({ content, file: ".env", config: cfg });

        expect(findings).toHaveLength(1);
        expect(findings[0].masked).toBe("abcd…mnop");
    });

    test("a real-shaped OpenAI key in an unquoted .env line is reported once, not twice", () => {
        const key = `sk-proj-${"a".repeat(48)}T3BlbkFJ${"b".repeat(48)}`;
        const content = `OPENAI_API_KEY=${key}`;
        const findings = scanContent({ content, file: ".env", config: cfg });

        expect(findings).toHaveLength(1);
    });

    test("ordinary dotenv lines with no secret-ish identifier are not flagged", () => {
        expect(scanContent({ content: "PORT=3000", file: ".env", config: cfg })).toHaveLength(0);
        expect(scanContent({ content: "NODE_ENV=production", file: ".env", config: cfg })).toHaveLength(0);
    });

    test("a function-call assignment is not flagged", () => {
        const content = "const token = getToken();";
        expect(scanContent({ content, file: "a.ts", config: cfg })).toHaveLength(0);
    });

    test("a short property-access assignment is not flagged", () => {
        const content = "password = input.value";
        expect(scanContent({ content, file: "a.ts", config: cfg })).toHaveLength(0);
    });

    // Regression test: #451 — the dotenv detector must not report ordinary config values as secrets.
    test("an identifier where 'auth' starts a longer word is not flagged", () => {
        const content = "AUTHOR_NAME=JonathanSmithson";
        expect(scanContent({ content, file: ".env", config: cfg })).toHaveLength(0);
    });

    test("a URL value without credentials is not flagged", () => {
        const content = "AUTH_URL=https://login.mycompany.io/oauth2";
        expect(scanContent({ content, file: ".env", config: cfg })).toHaveLength(0);
    });

    test("a URL value that carries a password is flagged", () => {
        // Built at runtime so this file holds no literal credential-bearing URL for scanners to flag.
        const password = ["s3cret", "pass"].join("");
        const content = `AUTH_URL=https://app:${password}@login.mycompany.io/oauth2`;
        expect(scanContent({ content, file: ".env", config: cfg })).toHaveLength(1);
    });

    // Regression test: PR #457 review — a URL counted as plain configuration whenever it had no
    // `user:pass@`, so a token carried in its query string was never reported.
    test("a URL value that carries a credential in its query string is flagged", () => {
        const token = ["a1B2", "c3D4", "e5F6", "g7H8"].join("");
        const content = `AUTH_URL=https://login.mycompany.io/callback?token=${token}`;
        expect(scanContent({ content, file: ".env", config: cfg })).toHaveLength(1);
    });

    test("a URL value whose query string carries no credential is not flagged", () => {
        const content = "AUTH_URL=https://login.mycompany.io/oauth2?client=webapp&prompt=consent";
        expect(scanContent({ content, file: ".env", config: cfg })).toHaveLength(0);
    });

    // Regression test: PR #457 review — the match ran on through a trailing comment, so a comment
    // repeating the value moved the finding onto the comment and the preview showed the real value.
    test("a trailing comment that repeats the value does not move the finding or unmask the value", () => {
        const value = ["a1B2", "c3D4", "e5F6", "g7H8"].join("");
        const content = `API_TOKEN=${value} # was ${value}`;
        const findings = scanContent({ content, file: ".env", config: cfg });

        expect(findings).toHaveLength(1);
        expect(findings[0].column).toBe("API_TOKEN=".length + 1);
        expect(findings[0].preview.startsWith(`API_TOKEN=${findings[0].masked}`)).toBe(true);
    });

    test("a filesystem path value is not flagged", () => {
        const content = "TOKEN_CACHE_DIR=/var/cache/someapp/tokens";
        expect(scanContent({ content, file: ".env", config: cfg })).toHaveLength(0);
    });

    test("a code assignment with spaces around = is not flagged", () => {
        const content = "password = settings.DATABASE_PASSWORD";
        expect(scanContent({ content, file: "settings.py", config: cfg })).toHaveLength(0);
    });
});

// Regression test: #451 round 2 — Twilio API Key SIDs (`SK` + 32 hex) are value-based and
// distinctive (gitleaks' own `twilio-api-key` rule: `SK[0-9a-fA-F]{32}`), so no identifier is
// needed. Account SIDs (`AC` + 32 hex, https://www.twilio.com/docs/glossary/what-is-a-sid)
// are resource identifiers, not secrets, and are deliberately NOT a detector on their own.
describe("twilio-api-key", () => {
    const cfg = defaultScanConfig();
    const sid = `SK${"a1b2c3d4".repeat(4)}`;

    test("a Twilio API Key SID is detected", () => {
        const content = `export const twilioKey = "${sid}";`;
        const findings = scanContent({ content, file: "a.ts", config: cfg });

        expect(findings).toHaveLength(1);
        expect(findings[0].detector).toBe("twilio-api-key");
    });

    test("a Twilio Account SID alone is not reported", () => {
        const accountSid = `AC${"a1b2c3d4".repeat(4)}`;
        const content = `const accountSid = "${accountSid}";`;

        expect(scanContent({ content, file: "a.ts", config: cfg })).toHaveLength(0);
    });

    test("a git SHA (40 hex chars) is never mistaken for a Twilio SID", () => {
        const sha = "a1b2c3d4".repeat(5); // 40 hex chars, no SK/AC prefix at all
        const content = `git checkout ${sha}`;

        expect(scanContent({ content, file: "notes.txt", config: cfg })).toHaveLength(0);
    });

    test("an MD5 hash is never mistaken for a Twilio SID", () => {
        const md5 = "d41d8cd98f00b204e9800998ecf8427e".slice(0, 32); // the empty-string MD5
        const content = `CHECKSUM=${md5}`;

        expect(scanContent({ content, file: ".env", config: cfg })).toHaveLength(0);
    });

    test("SK followed by 32 hex chars inside a longer word is not flagged", () => {
        const content = `"DESK${"a".repeat(32)}"`; // "...E" + "SK" + hex run, no word boundary before S

        expect(scanContent({ content, file: "a.ts", config: cfg })).toHaveLength(0);
    });

    test("an unquoted .env SID is reported once, not twice alongside dotenv-assignment", () => {
        const content = `TWILIO_API_KEY=${sid}`;

        expect(scanContent({ content, file: ".env", config: cfg })).toHaveLength(1);
    });
});

// Regression test: #451 round 2 — a Twilio auth token is a bare 32-char hex string with no
// fixed prefix (https://www.twilio.com/docs/iam/api/authtoken), so unlike the SID it is only
// reported when a Twilio-named identifier is assigned to it; TruffleHog's own detector
// (pkg/detectors/twilio/twilio.go) pairs the same bare `[0-9a-f]{32}` with a nearby Account SID
// for the same reason — a bare 32-hex run alone is indistinguishable from an MD5 hash.
describe("twilio-auth-token", () => {
    const cfg = defaultScanConfig();
    const token = "deadbeef".repeat(4); // 32 lowercase hex chars

    test("a Twilio-named identifier assigned to a 32-hex value is detected", () => {
        const content = `const twilioAuthToken = "${token}";`;
        const findings = scanContent({ content, file: "a.ts", config: cfg });

        expect(findings).toHaveLength(1);
        expect(findings[0].detector).toBe("twilio-auth-token");
    });

    test("the same 32-hex value unquoted in a dotenv line is detected once", () => {
        const content = `TWILIO_AUTH_TOKEN=${token}`;
        const findings = scanContent({ content, file: ".env", config: cfg });

        expect(findings).toHaveLength(1);
    });

    test("a 32-hex value with no Twilio-named identifier is not flagged", () => {
        const content = `SESSION_ID=${token}`;

        expect(scanContent({ content, file: ".env", config: cfg })).toHaveLength(0);
    });

    // Regression test: PR #456 review — any Twilio-named identifier qualified, so a checksum read as an auth token
    test("a Twilio-named checksum or id is not flagged; a Twilio token or secret name is", () => {
        const md5 = "d41d8cd98f00b204e9800998ecf8427e";

        expect(scanContent({ content: `TWILIO_CHECKSUM=${md5}`, file: ".env", config: cfg })).toHaveLength(0);
        expect(scanContent({ content: `const twilioRequestHash = "${md5}";`, file: "a.ts", config: cfg })).toHaveLength(
            0
        );
        expect(scanContent({ content: `TWILIO_TOKEN=${token}`, file: ".env", config: cfg })).toHaveLength(1);
        expect(scanContent({ content: `twilio_api_secret: "${token}"`, file: "a.yml", config: cfg })).toHaveLength(1);
    });

    test("an MD5 hash assigned to a non-Twilio identifier is not flagged", () => {
        const md5 = "d41d8cd98f00b204e9800998ecf8427e".slice(0, 32);
        const content = `CHECKSUM=${md5}`;

        expect(scanContent({ content, file: ".env", config: cfg })).toHaveLength(0);
    });
});

// Regression test: #451 round 2 — Resend's own documented shape
// (https://github.com/trufflesecurity/trufflehog/issues/5107, confirmed merged in
// pkg/detectors/resend/resend.go): `re_` + 8 base58-ish chars + `_` + 24 base58-ish chars.
// Fixed lengths rule out `re_render_count` / `re_match_groups` and similar snake_case
// identifiers structurally — neither segment is 8 or 24 characters long.
describe("resend-key", () => {
    const cfg = defaultScanConfig();
    const base58Chunk = "a1B2c3D4"; // no 0/O/I/l, matches the documented alphabet
    const key = `re_${base58Chunk}_${base58Chunk.repeat(3)}`;

    test("a Resend API key is detected", () => {
        const content = `const resend = new Resend("${key}");`;
        const findings = scanContent({ content, file: "a.ts", config: cfg });

        expect(findings).toHaveLength(1);
        expect(findings[0].detector).toBe("resend-key");
    });

    test("an unquoted .env key is reported once, not twice alongside dotenv-assignment", () => {
        const content = `RESEND_API_KEY=${key}`;

        expect(scanContent({ content, file: ".env", config: cfg })).toHaveLength(1);
    });

    test("re_render_count is not flagged", () => {
        expect(scanContent({ content: "const x = re_render_count;", file: "a.ts", config: cfg })).toHaveLength(0);
    });

    test("re_match_groups is not flagged", () => {
        expect(scanContent({ content: "const y = re_match_groups;", file: "a.ts", config: cfg })).toHaveLength(0);
    });

    test("a snake_case identifier starting with re_ is not flagged", () => {
        expect(scanContent({ content: "const z = re_fetch_data();", file: "a.ts", config: cfg })).toHaveLength(0);
    });
});

describe("walkFiles", () => {
    function makeRepo(): string {
        const dir = mkdtempSync(join(tmpdir(), "secrets-walk-"));
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
        const dir = mkdtempSync(join(tmpdir(), "secrets-dir-"));
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
        const dir = mkdtempSync(join(tmpdir(), "secrets-clean-"));
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

    test("long file paths keep a column gutter (do not collide with the detector)", () => {
        const longPath = "src/some/very/deeply/nested/area/that/is/long/component.test.ts";
        const wide: ScanResult = {
            ...result,
            findings: [{ ...result.findings[0], file: longPath, line: 1234 }],
        };
        const row = formatHuman(wide)
            .split("\n")
            .find((l) => l.includes(`${longPath}:1234`));
        expect(row).toBeDefined();
        // the location and detector must be separated by whitespace, never abut
        expect(row).toMatch(new RegExp(`${longPath.replace(/[/.$]/g, "\\$&")}:1234\\s{2,}aws-access-key-id`));
    });
});

describe("isPlaceholderSecret", () => {
    test("rejects template interpolation and format strings", () => {
        expect(isPlaceholderSecret("${provider}/${model}")).toBe(true);
        expect(isPlaceholderSecret("{{API_TOKEN}}")).toBe(true);
        expect(isPlaceholderSecret("prefix-%s-suffix")).toBe(true);
    });

    test("rejects angle-bracket / ellipsis fill-ins and xxx runs", () => {
        expect(isPlaceholderSecret("<your-api-key-here>")).toBe(true);
        expect(isPlaceholderSecret("abcdefghijkl...")).toBe(true);
        expect(isPlaceholderSecret("test-key-xxxx")).toBe(true);
    });

    test("rejects single-character runs and common placeholder words", () => {
        expect(isPlaceholderSecret("aaaaaaaaaaaaaaaa")).toBe(true);
        expect(isPlaceholderSecret("your-secret-value")).toBe(true);
        expect(isPlaceholderSecret("oauth-placeholder")).toBe(true);
        expect(isPlaceholderSecret("EXAMPLE_TOKEN_HERE")).toBe(true);
    });

    test("accepts a real-looking high-entropy token", () => {
        expect(isPlaceholderSecret("aB3xZ9qLkP2mWvT7uYrEoNcDfGhJ")).toBe(false);
        expect(isPlaceholderSecret("hunter2VeryLongPassword99")).toBe(false);
    });
});

describe("false-positive hardening", () => {
    const cfg = defaultScanConfig();

    function detectorsOn(content: string): string[] {
        return scanContent({ content, file: "a.ts", config: cfg }).map((f) => f.detector);
    }

    test("bare `key:` object properties no longer trip generic-assignment", () => {
        expect(detectorsOn('{ key: "daysOnMarket", label: "Days on Market" }')).toHaveLength(0);
        expect(detectorsOn('const CACHE_KEY = "usage-shared-cache";')).toHaveLength(0);
    });

    test("template-literal and placeholder values are not flagged", () => {
        expect(detectorsOn("const key = `${provider}/${model}`;")).toHaveLength(0);
        expect(detectorsOn('apiKey: "oauth-placeholder"')).toHaveLength(0);
        expect(detectorsOn('process.env.BRAVE_API_KEY = "test-key-xxx";')).toHaveLength(0);
    });

    test("values containing whitespace (prose / labels) are not flagged", () => {
        expect(detectorsOn('password = "this is just a sentence not a secret"')).toHaveLength(0);
    });

    test("a genuine credential-shaped assignment is still flagged", () => {
        const hits = detectorsOn('password = "hunter2VeryLongPassword99"');
        expect(hits).toContain("generic-assignment");
    });

    test("named credential identifiers still match after dropping bare `key`", () => {
        expect(detectorsOn('const apiKey = "aB3xZ9qLkP2mWvT7uYrEoNcDfGhJ";')).not.toHaveLength(0);
        expect(detectorsOn('privateKey = "aB3xZ9qLkP2mWvT7uYrEoNcDfGhJ"')).not.toHaveLength(0);
    });
});
