import { describe, expect, it } from "bun:test";
import type { CommitInfo, RawChange, StatusEntry } from "@genesiscz/utils/git";
import {
    committedChanges,
    describeCommitted,
    describeUncommitted,
    type FileChange,
    groupChangesByTime,
    sortNewestFirst,
    statusLetter,
    statusPair,
    timeBucketLabel,
    uncommittedChanges,
} from "./changes";

const NOW = new Date("2026-03-10T12:00:00Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function ago(ms: number): Date {
    return new Date(NOW.getTime() - ms);
}

function entry(partial: Partial<StatusEntry> & Pick<StatusEntry, "path">): StatusEntry {
    return { kind: "changed", index: ".", worktree: "M", ...partial };
}

function commit(sha: string, epochMs: number, parents: string[] = ["p"]): CommitInfo {
    const identity = { name: "Test", email: "test@example.com", epoch: epochMs / 1000 };

    return { sha, shortSha: sha.slice(0, 7), parents, author: identity, committer: identity, subject: "s", body: "" };
}

function change(partial: Partial<RawChange> & Pick<RawChange, "commit" | "path">): RawChange {
    return { oldMode: "100644", newMode: "100644", oldSha: "a", newSha: "b", status: "M", ...partial };
}

describe("timeBucketLabel", () => {
    const cases: Array<[string, number, string]> = [
        ["just now", 0, "Last hour"],
        ["59 minutes", 59 * MINUTE_MS, "Last hour"],
        ["1 hour", HOUR_MS, "Last 3 hours"],
        ["2 hours", 2 * HOUR_MS, "Last 3 hours"],
        ["3 hours", 3 * HOUR_MS, "Last 6 hours"],
        ["6 hours", 6 * HOUR_MS, "Last 12 hours"],
        ["12 hours", 12 * HOUR_MS, "Today"],
        ["23 hours", 23 * HOUR_MS, "Today"],
        ["24 hours", DAY_MS, "Yesterday"],
        ["47 hours", 47 * HOUR_MS, "Yesterday"],
        ["2 days", 2 * DAY_MS, "Last 2 days"],
        ["6 days", 6 * DAY_MS, "Last 6 days"],
        ["7 days", 7 * DAY_MS, "Older"],
        ["a month", 30 * DAY_MS, "Older"],
    ];

    for (const [name, ageMs, label] of cases) {
        it(`${name} old is "${label}"`, () => {
            expect(timeBucketLabel(ago(ageMs), NOW)).toBe(label);
        });
    }

    it("puts a file stamped in the future into the newest bucket", () => {
        expect(timeBucketLabel(ago(-5 * MINUTE_MS), NOW)).toBe("Last hour");
    });
});

describe("groupChangesByTime", () => {
    it("returns no groups for no files", () => {
        expect(groupChangesByTime([], NOW)).toEqual([]);
    });

    it("keeps newest-first order and merges neighbours that share a bucket", () => {
        const files: FileChange[] = [
            { file: "a", status: " M", mtime: ago(5 * MINUTE_MS) },
            { file: "b", status: "A ", mtime: ago(30 * MINUTE_MS) },
            { file: "c", status: "??", mtime: ago(2 * HOUR_MS) },
            { file: "d", status: " M", mtime: ago(3 * DAY_MS) },
            { file: "e", status: " M", mtime: ago(20 * DAY_MS) },
        ];
        const groups = groupChangesByTime(files, NOW);

        expect(groups.map((g) => [g.label, g.files.map((f) => f.file)])).toEqual([
            ["Last hour", ["a", "b"]],
            ["Last 3 hours", ["c"]],
            ["Last 3 days", ["d"]],
            ["Older", ["e"]],
        ]);
    });
});

describe("sortNewestFirst", () => {
    it("orders by mtime descending, keeps ties in input order and leaves the input alone", () => {
        const files: FileChange[] = [
            { file: "old", status: " M", mtime: ago(DAY_MS) },
            { file: "tie-1", status: " M", mtime: ago(HOUR_MS) },
            { file: "new", status: " M", mtime: ago(MINUTE_MS) },
            { file: "tie-2", status: " M", mtime: ago(HOUR_MS) },
        ];

        expect(sortNewestFirst(files).map((f) => f.file)).toEqual(["new", "tie-1", "tie-2", "old"]);
        expect(files.map((f) => f.file)).toEqual(["old", "tie-1", "new", "tie-2"]);
    });
});

describe("statusPair", () => {
    it("shows an unchanged side as a space, like git status --short", () => {
        expect(statusPair(entry({ path: "a", index: ".", worktree: "M" }))).toBe(" M");
        expect(statusPair(entry({ path: "a", index: "A", worktree: "." }))).toBe("A ");
        expect(statusPair(entry({ path: "a", index: "M", worktree: "M" }))).toBe("MM");
    });

    it("keeps an untracked entry as ??", () => {
        expect(statusPair(entry({ kind: "untracked", path: "a", index: "?", worktree: "?" }))).toBe("??");
    });
});

describe("statusLetter", () => {
    it("takes the index side when it has one, else the worktree side", () => {
        expect(statusLetter("M ")).toBe("M");
        expect(statusLetter("AM")).toBe("A");
        expect(statusLetter(" D")).toBe("D");
        expect(statusLetter(" M")).toBe("M");
        expect(statusLetter("??")).toBe("?");
    });
});

describe("uncommittedChanges", () => {
    const edited = ago(10 * MINUTE_MS);
    const movedTo = ago(40 * MINUTE_MS);
    const mtimes = new Map<string, Date>([
        ["src/edited.ts", edited],
        ["src/moved-to.ts", movedTo],
        ["notes/new.md", ago(2 * HOUR_MS)],
        ["src/staged.ts", ago(5 * DAY_MS)],
    ]);
    const lookup = (path: string): Date | null => mtimes.get(path) ?? null;

    it("sorts newest first and stamps each file with its own mtime", () => {
        const files = uncommittedChanges(
            [
                entry({ path: "src/staged.ts", index: "M", worktree: "." }),
                entry({ kind: "untracked", path: "notes/new.md", index: "?", worktree: "?" }),
                entry({ path: "src/edited.ts" }),
            ],
            lookup,
            NOW
        );

        expect(files.map((f) => [f.file, f.status])).toEqual([
            ["src/edited.ts", " M"],
            ["notes/new.md", "??"],
            ["src/staged.ts", "M "],
        ]);
        expect(files[0].mtime).toEqual(edited);
    });

    it("lists a rename under its new path with the R status", () => {
        const files = uncommittedChanges(
            [
                entry({
                    kind: "renamed",
                    path: "src/moved-to.ts",
                    origPath: "src/moved-from.ts",
                    index: "R",
                    worktree: ".",
                    score: 100,
                }),
            ],
            lookup,
            NOW
        );

        expect(files).toEqual([{ file: "src/moved-to.ts", status: "R ", mtime: movedTo }]);
    });

    it("counts a deleted file as touched now, in both the staged and the unstaged form", () => {
        const files = uncommittedChanges(
            [
                entry({ path: "gone-unstaged.ts", index: ".", worktree: "D" }),
                entry({ path: "gone-staged.ts", index: "D", worktree: "." }),
                entry({ path: "src/edited.ts" }),
            ],
            lookup,
            NOW
        );

        expect(files.map((f) => [f.file, f.status, f.mtime.getTime() === NOW.getTime()])).toEqual([
            ["gone-unstaged.ts", " D", true],
            ["gone-staged.ts", "D ", true],
            ["src/edited.ts", " M", false],
        ]);
    });

    it("leaves out a path that is not deleted but cannot be read, and an ignored entry", () => {
        const files = uncommittedChanges(
            [
                entry({ path: "vanished.ts" }),
                entry({ kind: "ignored", path: "dist/out.js", index: "!", worktree: "!" }),
                entry({ path: "src/edited.ts" }),
            ],
            lookup,
            NOW
        );

        expect(files.map((f) => f.file)).toEqual(["src/edited.ts"]);
    });

    it("returns nothing for a clean tree", () => {
        expect(uncommittedChanges([], lookup, NOW)).toEqual([]);
    });
});

describe("committedChanges", () => {
    it("stamps each file with its commit's committer time, newest first", () => {
        const files = committedChanges(
            [commit("c1", NOW.getTime() - HOUR_MS), commit("c2", NOW.getTime() - 3 * DAY_MS)],
            [
                change({ commit: "c1", path: "a.ts", status: "M" }),
                change({ commit: "c2", path: "b.ts", status: "A" }),
                change({ commit: "c1", path: "c.ts", status: "D" }),
            ]
        );

        expect(files.map((f) => [f.file, f.status])).toEqual([
            ["a.ts", "M "],
            ["c.ts", "D "],
            ["b.ts", "A "],
        ]);
        expect(files[0].mtime.getTime()).toBe(NOW.getTime() - HOUR_MS);
    });

    it("lists a rename under its new path", () => {
        const files = committedChanges(
            [commit("c1", NOW.getTime() - HOUR_MS)],
            [change({ commit: "c1", path: "new/name.ts", origPath: "old/name.ts", status: "R" })]
        );

        expect(files.map((f) => [f.file, f.status])).toEqual([["new/name.ts", "R "]]);
    });

    it("lists nothing of a merge commit's own", () => {
        const files = committedChanges(
            [commit("merge", NOW.getTime() - MINUTE_MS, ["p1", "p2"]), commit("c1", NOW.getTime() - HOUR_MS)],
            [change({ commit: "merge", path: "from-merge.ts" }), change({ commit: "c1", path: "own.ts" })]
        );

        expect(files.map((f) => f.file)).toEqual(["own.ts"]);
    });

    it("ignores a change whose commit is not in the history it was given", () => {
        expect(committedChanges([], [change({ commit: "orphan", path: "a.ts" })])).toEqual([]);
    });
});

describe("status descriptions", () => {
    it("describes uncommitted states", () => {
        expect(describeUncommitted("??")).toBe("untracked");
        expect(describeUncommitted("MM")).toBe("modified (staged & unstaged)");
        expect(describeUncommitted("M ")).toBe("modified (staged)");
        expect(describeUncommitted(" M")).toBe("modified (unstaged)");
        expect(describeUncommitted("A ")).toBe("added (staged)");
        expect(describeUncommitted(" D")).toBe("deleted (unstaged)");
        expect(describeUncommitted("R ")).toBe("renamed (staged)");
        expect(describeUncommitted("UU")).toBe("UU");
    });

    it("names both sides when the index and the worktree changed in different ways", () => {
        expect(describeUncommitted("AM")).toBe("added (staged), modified (unstaged)");
        expect(describeUncommitted("RM")).toBe("renamed (staged), modified (unstaged)");
        expect(describeUncommitted("MD")).toBe("modified (staged), deleted (unstaged)");
    });

    it("describes committed states and passes an unknown one through", () => {
        expect(describeCommitted("M ")).toBe("modified");
        expect(describeCommitted("A ")).toBe("added");
        expect(describeCommitted("D ")).toBe("deleted");
        expect(describeCommitted("R ")).toBe("renamed");
        expect(describeCommitted("C ")).toBe("copied");
        expect(describeCommitted("T ")).toBe("T");
    });
});
