import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { join, resolve } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import axios from 'axios';

// Path to the script to be tested
const scriptPath = resolve(__dirname, "./index.ts");

// Mock axios
const axiosGetSpy = spyOn(axios, 'get');

interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

async function runScript(args: string[], envVars: Record<string, string> = {}): Promise<ExecResult> {
    const proc = Bun.spawn({
        cmd: ["bun", "run", scriptPath, ...args],
        cwd: process.cwd(), 
        env: { ...process.env, ...envVars },
        stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
}

// Sample GitHub Release Data
const mockReleases = [
    {
        tag_name: "v1.0.0",
        name: "Version 1.0.0",
        published_at: "2023-01-15T10:00:00Z",
        body: "Initial release content.",
        html_url: "https://github.com/testowner/testrepo/releases/tag/v1.0.0"
    },
    {
        tag_name: "v1.1.0",
        name: "Version 1.1.0",
        published_at: "2023-02-20T12:00:00Z",
        body: "Update features for 1.1.0.",
        html_url: "https://github.com/testowner/testrepo/releases/tag/v1.1.0"
    },
    {
        tag_name: "v0.9.0",
        name: "Version 0.9.0",
        published_at: "2022-12-25T08:00:00Z",
        body: "Beta release content.",
        html_url: "https://github.com/testowner/testrepo/releases/tag/v0.9.0"
    }
];
/*
describe("github-release-notes", () => {
    let testDir: string;

    beforeEach(async () => {
        const baseTmpDir = realpathSync(tmpdir());
        testDir = await mkdtemp(join(baseTmpDir, "test-gh-releases-"));
        axiosGetSpy.mockReset(); // Reset spy before each test
    });

    afterEach(async () => {
        if (testDir) {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it("should show help with --help flag", async () => {
        const { stdout, exitCode } = await runScript(["--help"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Usage: tools github-release-notes <owner>/<repo>|<github-url> <output-file>");
    });

    it("should show help if no arguments are provided", async () => {
        const { stdout, exitCode } = await runScript([]);
        expect(exitCode).toBe(0); // Script exits 0 with help
        expect(stdout).toContain("Usage: tools github-release-notes <owner>/<repo>|<github-url> <output-file>");
    });

    it("should exit with error for invalid repo format", async () => {
        const outputFile = join(testDir, "out.md");
        const { stdout, stderr, exitCode } = await runScript(["invalid-repo", outputFile]);
        expect(exitCode).toBe(1);
        // The script's logger outputs to stdout by default for info/error
        expect(stdout).toContain("Invalid repository format.");
    });

    it("should fetch and write release notes to file (newest first by default)", async () => {
        axiosGetSpy.mockResolvedValue({ data: mockReleases });
        const outputFile = join(testDir, "releases.md");

        const { exitCode, stdout, stderr } = await runScript(["testowner/testrepo", outputFile]);
        
        // console.log("STDOUT:", stdout);
        // console.log("STDERR:", stderr);
        expect(exitCode).toBe(0);
        expect(axiosGetSpy).toHaveBeenCalledWith(
            "https://api.github.com/repos/testowner/testrepo/releases?per_page=100&page=1",
            expect.any(Object)
        );

        const content = await readFile(outputFile, "utf-8");
        expect(content).toContain("# Release Notes: testowner/testrepo");
        expect(content).toMatch(/## \[v1\.1\.0\].*?2023-02-20.*?Update features for 1\.1\.0\./s);
        expect(content).toMatch(/## \[v1\.0\.0\].*?2023-01-15.*?Initial release content\./s);
        expect(content).toMatch(/## \[v0\.9\.0\].*?2022-12-25.*?Beta release content\./s);
        // Check order (newest first)
        expect(content.indexOf("v1.1.0")).toBeLessThan(content.indexOf("v1.0.0"));
        expect(content.indexOf("v1.0.0")).toBeLessThan(content.indexOf("v0.9.0"));
    });

    it("should fetch and write release notes sorted oldest first with --oldest", async () => {
        axiosGetSpy.mockResolvedValue({ data: mockReleases });
        const outputFile = join(testDir, "releases_oldest.md");

        const { exitCode } = await runScript(["testowner/testrepo", outputFile, "--oldest"]);
        expect(exitCode).toBe(0);

        const content = await readFile(outputFile, "utf-8");
        expect(content).toContain("# Release Notes: testowner/testrepo");
        // Check order (oldest first)
        expect(content.indexOf("v0.9.0")).toBeLessThan(content.indexOf("v1.0.0"));
        expect(content.indexOf("v1.0.0")).toBeLessThan(content.indexOf("v1.1.0"));
    });

    it("should limit releases with --limit", async () => {
        axiosGetSpy.mockResolvedValue({ data: mockReleases });
        const outputFile = join(testDir, "releases_limit.md");

        const { exitCode } = await runScript(["testowner/testrepo", outputFile, "--limit=2"]);
        expect(exitCode).toBe(0);

        const content = await readFile(outputFile, "utf-8");
        // Default sort is newest first. With limit 2, we expect v1.1.0 and v1.0.0
        expect(content).toContain("v1.1.0");
        expect(content).toContain("v1.0.0");
        expect(content).not.toContain("v0.9.0");
    });

    it("should use GITHUB_TOKEN if set", async () => {
        axiosGetSpy.mockResolvedValue({ data: [] }); // No releases needed, just check headers
        const outputFile = join(testDir, "out.md");

        await runScript(["testowner/testrepo", outputFile], { GITHUB_TOKEN: "test_token_123" });

        expect(axiosGetSpy).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: "token test_token_123" })
            })
        );
    });

    it("should handle API error for 404 not found", async () => {
        axiosGetSpy.mockRejectedValue({ 
            isAxiosError: true, 
            response: { status: 404, data: "Not Found" },
            message: "Request failed with status code 404"
        });
        const outputFile = join(testDir, "out.md");
        const { stdout, stderr,exitCode } = await runScript(["testowner/testrepo", outputFile]);
        expect(exitCode).toBe(1);
        console.error("STDOUT:", stdout+" STDERR:"+stderr);
        expect(stdout).toContain("Repository testowner/testrepo not found or no releases available.");
    });

    it("should handle API error for 403 rate limit", async () => {
        axiosGetSpy.mockRejectedValue({ 
            isAxiosError: true, 
            response: { status: 403, data: "API rate limit exceeded" },
            message: "Request failed with status code 403"
        });
        const outputFile = join(testDir, "out.md");
        const { stdout, exitCode } = await runScript(["testowner/testrepo", outputFile]);
        expect(exitCode).toBe(1);
        console.error("STDOUT:", stdout);
        expect(stdout).toContain("Rate limit exceeded.");
    });

    it("should parse full GitHub URL for repo arg", async () => {
        axiosGetSpy.mockResolvedValue({ data: [mockReleases[0]] });
        const outputFile = join(testDir, "releases_url.md");

        const { exitCode } = await runScript([
            "https://github.com/anotherowner/anotherrepo.git", 
            outputFile
        ]);
        expect(exitCode).toBe(0);
        expect(axiosGetSpy).toHaveBeenCalledWith(
            "https://api.github.com/repos/anotherowner/anotherrepo/releases?per_page=100&page=1",
            expect.any(Object)
        );
        const content = await readFile(outputFile, "utf-8");
        expect(content).toContain("# Release Notes: anotherowner/anotherrepo");
    });

    it("should correctly paginate if limit > 100 (mocking multiple pages)", async () => {
        const manyReleasesPage1 = Array(100).fill(null).map((_, i) => ({
            ...mockReleases[0], tag_name: `v_page1_${i}`,
        }));
        const manyReleasesPage2 = Array(50).fill(null).map((_, i) => ({
            ...mockReleases[1], tag_name: `v_page2_${i}`,
        }));

        axiosGetSpy
            .mockResolvedValueOnce({ data: manyReleasesPage1 })
            .mockResolvedValueOnce({ data: manyReleasesPage2 })
            .mockResolvedValueOnce({ data: [] }); // Empty page to stop pagination

        const outputFile = join(testDir, "releases_paged.md");
        const { exitCode, stdout, stderr } = await runScript(["testowner/testrepo", outputFile, "--limit=150"]);

        expect(exitCode).toBe(0);
        expect(axiosGetSpy).toHaveBeenCalledTimes(3); // Page 1, Page 2, Page 3 (empty)
        expect(axiosGetSpy.mock.calls[0][0]).toContain("page=1");
        expect(axiosGetSpy.mock.calls[1][0]).toContain("page=2");
        expect(axiosGetSpy.mock.calls[2][0]).toContain("page=3");

        const content = await readFile(outputFile, "utf-8");
        expect(content).toContain("v_page1_0");
        expect(content).toContain("v_page1_99");
        expect(content).toContain("v_page2_0");
        expect(content).toContain("v_page2_49");
        // Count occurrences of "## [v_page"
        const releaseHeaders = content.match(/## \[v_page/g);
        expect(releaseHeaders?.length).toBe(150);
    });
}); */