import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { AxiosError, AxiosHeaders, type AxiosResponse } from "axios";
import pino from "pino";
import { axiosLogFields, extractErrors } from "./errors";

describe("extractErrors", () => {
    it("finds FAIL lines with ±5 context for short logs", () => {
        const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
        lines[14] = "FAIL packages/foo/foo.test.ts";
        const errs = extractErrors(lines.join("\n"));
        expect(errs).toHaveLength(1);
        expect(errs[0].matched).toContain("FAIL packages/foo");
        expect(errs[0].line).toBe(15);
        expect(errs[0].window).toHaveLength(11);
    });

    it("uses ±3 window for long logs (>100 lines)", () => {
        const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
        lines[150] = "Error: something exploded";
        const errs = extractErrors(lines.join("\n"));
        expect(errs).toHaveLength(1);
        expect(errs[0].window).toHaveLength(7);
    });

    it("respects custom pattern", () => {
        const text = "line 1\nCUSTOMFAIL boom\nline 3";
        const errs = extractErrors(text, { pattern: /CUSTOMFAIL/ });
        expect(errs).toHaveLength(1);
    });

    it("caps results at maxBlocks", () => {
        const blocks: string[] = [];

        for (let i = 0; i < 20; i++) {
            blocks.push(`FAIL ${i}`);
            // separator to prevent window merging
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
        }

        const errs = extractErrors(blocks.join("\n"), { maxBlocks: 3 });
        expect(errs).toHaveLength(3);
    });

    it("merges overlapping windows from adjacent matches", () => {
        const text = `ok\nFAIL one\nFAIL two\nok\n${"ok\n".repeat(20)}`;
        const errs = extractErrors(text);
        expect(errs).toHaveLength(1);
        expect(errs[0].matched).toContain("FAIL one");
    });

    it("does not skip matches when caller passes a /g regex (resets lastIndex)", () => {
        const lines = ["alpha bravo", "charlie bravo", "delta bravo"];
        const errs = extractErrors(lines.join("\n"), { pattern: /bravo/g });
        expect(errs.length).toBeGreaterThan(0);
        // All three lines match — without re.lastIndex reset, the /g state would skip lines 2/3.
        expect(errs[0].matched).toContain("alpha");
    });
});

describe("extractErrors (agnostic patterns)", () => {
    it.each([
        ["BUILD FAILED in 2m 14s"],
        ["FAILURE: Build failed with an exception."],
        ["Execution failed for task ':app:bundleRelease'."],
        ["* What went wrong:"],
        ["Caused by: java.io.FileNotFoundException"],
        // Mixed-case variants — case-insensitive matching is required to catch
        // failures from tools that don't shout in ALL CAPS.
        ["Failed to add tarball from registry"],
        ["error: cannot find symbol 'foo'"],
        ['Exception in thread "main"'],
        // Node/pnpm/esbuild-style error codes
        ["ERR_PNPM_UNKNOWN  Failed to add tarball"],
        ["ERR_REQUIRE_ESM cannot require ES module"],
    ])("matches '%s'", (line) => {
        const text = `line a\nline b\n${line}\nline d`;
        const errs = extractErrors(text);
        expect(errs.length).toBeGreaterThan(0);
        expect(errs[0].matched).toContain(line.slice(0, 10));
    });
});

describe("axiosLogFields", () => {
    const TOKEN = "SUPER_SECRET_JENKINS_TOKEN";

    function jenkinsAxiosError(): AxiosError {
        const headers = new AxiosHeaders();
        const config = {
            url: "/job/deploy/42/api/json",
            method: "get",
            baseURL: "https://jenkins.example.com",
            auth: { username: "ci-user", password: TOKEN },
            headers,
        };
        return new AxiosError("Request failed with status code 500", "ERR_BAD_RESPONSE", config, {}, {
            status: 500,
            statusText: "Internal Server Error",
            data: {},
            headers,
            config,
        } as AxiosResponse);
    }

    it("keeps the fields needed to reconstruct a failed call", () => {
        const fields = axiosLogFields(jenkinsAxiosError());

        expect(fields.message).toBe("Request failed with status code 500");
        expect(fields.code).toBe("ERR_BAD_RESPONSE");
        expect(fields.status).toBe(500);
        expect(fields.method).toBe("get");
        expect(fields.url).toBe("/job/deploy/42/api/json");
        expect(fields.stack).toBeDefined();
    });

    it("drops the basic-auth credentials that pino would otherwise serialize", () => {
        const error = jenkinsAxiosError();

        // Control: the raw error really does leak, so this test is load-bearing.
        expect(SafeJSON.stringify(pino.stdSerializers.err(error))).toContain(TOKEN);

        expect(SafeJSON.stringify(axiosLogFields(error))).not.toContain(TOKEN);
    });
});
