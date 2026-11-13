import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { Command } from "commander";
import { registerMeetingCommands } from "../commands/meeting";
import { contextEntryText, contextFileRevision, contextFileText } from "./context-file";
import { duplicateMeeting } from "./duplicate";
import { rawTerms } from "./suggest";

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

const revisionText =
    "Every project document keeps its original title and stable location.\n\nUse `ProjectData.offerSection`.\n";

async function revisionFixture(
    check: (fixture: {
        root: string;
        page: string;
        commit: string;
        store: MeetingStore;
        id: string;
        run: (...args: string[]) => Promise<void>;
        advance: (text: string) => string;
    }) => Promise<void>
): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "gt-test-context-revision-"));
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: root }, async () => {
        const runGit = (args: string[], date: string) => {
            const result = Bun.spawnSync(
                ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args],
                {
                    cwd: root,
                    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
                    stdout: "pipe",
                    stderr: "pipe",
                }
            );
            expect(result.exitCode).toBe(0);
            return result.stdout.toString().trim();
        };
        runGit(["init", "-q"], "2026-03-01T10:00:00Z");
        const selectedPage = join(root, "Project notes.md");
        writeFileSync(selectedPage, revisionText);
        runGit(["add", "--", "Project notes.md"], "2026-03-01T10:00:00Z");
        runGit(["commit", "-qm", "original page"], "2026-03-01T10:00:00Z");
        const commit = runGit(["rev-parse", "HEAD"], "2026-03-01T10:00:00Z");
        writeFileSync(selectedPage, "The replacement page has different wording and no identifiers.\n");
        runGit(["commit", "-qam", "edit during meeting"], "2026-03-02T15:30:00Z");
        const store = new MeetingStore();
        const record = await store.create(
            { title: "Fixture planning", start: "2026-03-02T15:00:00Z", end: "2026-03-02T16:00:00Z", createdBy: "new" },
            { command: "test", change: "fixture" }
        );
        const run = async (...args: string[]) => {
            const command = new Command().exitOverride();
            registerMeetingCommands(command);
            await command.parseAsync(["context", "add", record.id, ...args], { from: "user" });
        };
        const advance = (text: string) => {
            writeFileSync(selectedPage, text);
            runGit(["commit", "-qam", "later page"], "2026-03-03T10:00:00Z");
            return runGit(["rev-parse", "HEAD"], "2026-03-03T10:00:00Z");
        };
        await check({ root, page: selectedPage, commit, store, id: record.id, run, advance });
    });
}

describe("explicit context revisions", () => {
    for (const flag of ["--rev", "--before-meeting"]) {
        it(`${flag} persists the selected text for raw document evidence after deletion and duplication`, async () => {
            await revisionFixture(async ({ page, commit, store, id, run, advance }) => {
                await run(page, flag, ...(flag === "--rev" ? [commit] : []));
                const reopened = new MeetingStore().read(id)!;
                expect(reopened.context[0]).toMatchObject({
                    kind: "file",
                    ref: page,
                    file: { revision: { commit, text: revisionText } },
                });
                expect(SafeJSON.parse(readFileSync(store.path(id), "utf8"))).toMatchObject({
                    context: [{ file: { revision: { commit, text: revisionText } } }],
                });
                advance("An entirely different document after the selection.\n");
                expect(contextEntryText(new MeetingStore().read(id)!.context[0], reopened)?.text).toBe(revisionText);
                rmSync(page);
                const copied = await duplicateMeeting({ store, ref: id, withoutItems: true });
                for (const recordId of [id, copied.id]) {
                    const saved = new MeetingStore().read(recordId)!;
                    const persisted = readFileSync(store.path(recordId), "utf8");
                    const meeting: SourceMeeting = {
                        sourceMeetingId: "fixture",
                        title: saved.title,
                        start: saved.start,
                        participants: [],
                        speakers: [],
                        folders: [],
                        transcript: [
                            {
                                speaker: "Alice Example",
                                startSec: 0,
                                text: "Every project document keeps its original title and stable location.",
                            },
                            { speaker: "Alice Example", startSec: 10, text: "project data offer section" },
                        ],
                    };
                    const terms = rawTerms({
                        record: saved,
                        meeting,
                        dictionary: { entries: [], abbrExpansion: "every" },
                        sourceWords: [],
                    });
                    expect(terms.documents.readAloud).toContainEqual(
                        expect.objectContaining({
                            text: "Every project document keeps its original title and stable location",
                        })
                    );
                    expect(terms.documents.identifiers).toContainEqual(
                        expect.objectContaining({ identifier: "ProjectData.offerSection" })
                    );
                    expect(readFileSync(store.path(recordId), "utf8")).toBe(persisted);
                }
            });
        });
    }

    it("does not rewrite snapshot text that begins with the original meeting folder when duplicating", async () => {
        await revisionFixture(async ({ page, store, id, run, advance }) => {
            const text = `${store.folder(id)}/reference content\n`;
            const commit = advance(text);
            await run(page, "--rev", commit);
            const copied = await duplicateMeeting({ store, ref: id, withoutItems: true });
            expect(new MeetingStore().read(copied.id)!.context[0].file?.revision).toEqual({ commit, text });
            expect(SafeJSON.parse(readFileSync(store.path(copied.id), "utf8"))).toMatchObject({
                context: [{ file: { revision: { commit, text } } }],
            });
        });
    });

    it("accepts an existing symlink and a deleted committed file, while rejecting invalid selections", async () => {
        await revisionFixture(async ({ root, page, commit, id, run }) => {
            const alias = join(root, "Alias notes.md");
            symlinkSync(page, alias);
            await run(alias, "--rev", commit);
            expect(new MeetingStore().read(id)!.context[0].file?.revision).toEqual({ commit, text: revisionText });
            expect(() =>
                contextFileRevision({ path: page, start: "2026-03-02T15:00:00Z", rev: commit, beforeMeeting: true })
            ).toThrow("cannot be used together");
            expect(() => contextFileRevision({ path: root, start: "2026-03-02T15:00:00Z", rev: commit })).toThrow(
                "Not a file"
            );
            expect(() => contextFileRevision({ path: page, start: "2026-03-02T15:00:00Z", rev: "--help" })).toThrow(
                "Cannot read"
            );
            expect(() =>
                contextFileRevision({ path: page, start: "2020-01-01T00:00:00Z", beforeMeeting: true })
            ).toThrow("before meeting start");
            expect(() =>
                contextFileRevision({ path: join(root, "Never.md"), start: "2026-03-02T15:00:00Z", rev: commit })
            ).toThrow("Cannot read");
            rmSync(page);
            await run(page, "--rev", commit);
            expect(new MeetingStore().read(id)!.context[1].file?.revision).toEqual({ commit, text: revisionText });
        });
    });

    it("rejects revision flags on a URL or note without changing stored context", async () => {
        await revisionFixture(async ({ id, run }) => {
            const oldExitCode = process.exitCode;
            try {
                await run("https://example.com/page", "--rev", "HEAD");
                expect(process.exitCode).toBe(1);
                await run("--note", "Fixture note", "--before-meeting");
                expect(process.exitCode).toBe(1);
                expect(new MeetingStore().read(id)!.context).toEqual([]);
            } finally {
                process.exitCode = oldExitCode;
            }
        });
    });

    it("keeps ordinary disk context as a reference without saved revision data", async () => {
        await revisionFixture(async ({ page, id, run }) => {
            await run(page);
            const reopened = new MeetingStore().read(id)!;
            expect(reopened.context[0]).toMatchObject({ kind: "file", ref: page });
            expect(reopened.context[0]).not.toHaveProperty("file");
            expect(contextEntryText(reopened.context[0], reopened)?.text).toBe(
                "The replacement page has different wording and no identifiers.\n"
            );
        });
    });
});
