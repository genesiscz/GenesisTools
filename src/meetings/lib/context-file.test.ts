import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextFileText } from "./context-file";

const repo = mkdtempSync(join(tmpdir(), "gt-test-context-file-"));
const page = join(repo, "Proposals.md");
const meetingEnd = new Date("2026-03-02T16:00:00Z");

function git(...args: string[]): void {
    const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: repo,
        env: { ...process.env, GIT_COMMITTER_DATE: "2026-03-01T10:00:00Z", GIT_AUTHOR_DATE: "2026-03-01T10:00:00Z" },
    });
    expect(run.exitCode).toBe(0);
}

git("init", "-q");
writeFileSync(page, "line one\nthe line read aloud\n");
git("add", "Proposals.md");
git("commit", "-q", "-m", "page as the meeting saw it");

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("a context file as the meeting saw it", () => {
    it("reads the file on disk when it did not change after the meeting", () => {
        utimesSync(page, new Date("2026-03-01T10:00:00Z"), new Date("2026-03-01T10:00:00Z"));

        expect(contextFileText(page, meetingEnd)).toEqual({ text: "line one\nthe line read aloud\n", from: "disk" });
    });

    it("reads the commit before the meeting when the page was edited after it", () => {
        writeFileSync(page, "a new first line\nline one\nthe line read aloud\n");

        const file = contextFileText(page, meetingEnd);

        expect(file?.from).toBe("git");
        expect(file?.text).toBe("line one\nthe line read aloud\n");
    });

    it("reads the commit before the meeting when the page was deleted after it", () => {
        rmSync(page);

        expect(contextFileText(page, meetingEnd)?.text).toBe("line one\nthe line read aloud\n");
    });

    it("gives nothing for a file that is gone and was never committed", () => {
        expect(contextFileText(join(repo, "Never.md"), meetingEnd)).toBeUndefined();
    });
});
