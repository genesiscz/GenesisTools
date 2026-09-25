import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import * as paths from "@genesiscz/utils/paths";
import { selectResumeSession } from "./select-resume";
import type { AgentSession, AgentSessionAdapter } from "./types";

/**
 * The shape `historySourceKey` (./identity.ts) actually stores: provider, realpath'd home,
 * native id. Spelled out rather than called because that helper realpaths the home, so it
 * cannot name a directory a unit test has not created.
 */
const sourceKeyFor = (home: string, nativeId: string) => SafeJSON.stringify(["codex", home, nativeId]);

const realPrintln = out.println;
const realPrintlnErr = out.printlnErr;

/**
 * Capture the candidate table an ambiguous non-interactive resume prints before it fails.
 *
 * It goes to STDERR: this is the failure path, and stdout belongs to the machine result. Both
 * writers are captured so a regression that moves it back to stdout shows up as a failure here
 * rather than as silence.
 */
function capturePrinted(): { err: string[]; outLines: string[] } {
    const err: string[] = [];
    const outLines: string[] = [];
    out.printlnErr = (raw?: unknown, ...rest: unknown[]) => {
        err.push([raw, ...rest].map(String).join(" "));
    };
    out.println = (raw?: unknown, ...rest: unknown[]) => {
        outLines.push([raw, ...rest].map(String).join(" "));
    };

    return { err, outLines };
}

afterEach(() => {
    out.println = realPrintln;
    out.printlnErr = realPrintlnErr;
});

const session = (sessionId: string, title: string): AgentSession => ({
    kind: "codex",
    sessionId,
    title,
    cwd: "/project",
    mtime: new Date(0),
    filePath: `/sessions/${sessionId}.jsonl`,
});
function adapter(sessions: AgentSession[], content: AgentSession[] = []): AgentSessionAdapter {
    return { kind: "codex", list: async () => sessions, search: async () => content };
}

test("an exact ID wins over another ID with the same prefix", async () => {
    const exact = session("abc", "one");
    expect(
        await selectResumeSession({
            adapter: adapter([session("abcd", "two"), exact]),
            query: "abc",
            interactive: false,
        })
    ).toBe(exact);
});
test("content matches are used after metadata and preserve provider scope", async () => {
    const native = session("native", "untitled");
    const other = { ...session("other", "invoice"), kind: "claude" as const };
    expect(
        await selectResumeSession({ adapter: adapter([], [other, native]), query: "invoice", interactive: false })
    ).toBe(native);
});
test("ambiguous and empty non-interactive results never silently resume a session", async () => {
    await expect(
        selectResumeSession({
            adapter: adapter([session("a", "invoice one"), session("b", "invoice two")]),
            query: "invoice",
            interactive: false,
        })
    ).rejects.toThrow("Ambiguous");
    await expect(selectResumeSession({ adapter: adapter([]), query: "missing", interactive: false })).rejects.toThrow(
        "No codex"
    );
});

test("a full native UUID is resumable outside the current project without --all", async () => {
    const foreign = { ...session("11111111-1111-4111-8111-111111111111", "Foreign topic"), cwd: "/other-project" };
    const scoped: AgentSessionAdapter = {
        kind: "codex",
        list: async (filters) => (!filters.cwd || filters.cwd === foreign.cwd ? [foreign] : []),
        search: async () => [],
    };
    expect(
        await selectResumeSession({
            adapter: scoped,
            query: foreign.sessionId,
            filters: { cwd: "/current-project" },
            interactive: false,
        })
    ).toBe(foreign);
    await expect(
        selectResumeSession({
            adapter: scoped,
            query: "Foreign topic",
            filters: { cwd: "/current-project" },
            interactive: false,
        })
    ).rejects.toThrow("No codex");
});

test("a canonical copy wins for an explicit UUID while a missing UUID never resumes a text mention", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const canonical = { ...session(id, "Copied"), sourceHome: "/canonical" };
    const old = { ...session(id, "Original"), sourceHome: "/old-home" };
    expect(
        await selectResumeSession({
            adapter: adapter([old, canonical]),
            query: id,
            preferredHome: "/canonical",
            interactive: false,
        })
    ).toBe(canonical);
    await expect(
        selectResumeSession({ adapter: adapter([], [session("unrelated", id)]), query: id, interactive: false })
    ).rejects.toThrow("No codex");
});

test("a title match resolves to the launch home's copy, but two different sessions stay ambiguous", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const local = { ...session(id, "astra-pricing"), sourceHome: "/home" };
    const retained = { ...session(id, "astra-pricing"), sourceHome: "/old-home" };
    expect(
        await selectResumeSession({
            adapter: adapter([retained, local]),
            query: "astra-pricing",
            preferredHome: "/home",
            interactive: false,
        })
    ).toBe(local);
    const other = { ...session("44444444-4444-4444-8444-444444444444", "astra-pricing"), sourceHome: "/old-home" };
    await expect(
        selectResumeSession({
            adapter: adapter([other, local]),
            query: "astra-pricing",
            preferredHome: "/home",
            interactive: false,
        })
    ).rejects.toThrow("Ambiguous");
});
test("an ambiguous non-interactive resume prints the candidates before it refuses", async () => {
    // Naming only the count tells the user the query was too broad and nothing about which
    // query would be narrow enough. Claude's resume has always printed the table; the shared
    // path named the count alone, so codex and grok had no way to pick a session id.
    const printed = capturePrinted();

    await expect(
        selectResumeSession({
            adapter: adapter([session("aaaa1111", "invoice one"), session("bbbb2222", "invoice two")]),
            query: "invoice",
            interactive: false,
        })
    ).rejects.toThrow("Pass a session id from the table above");

    const table = printed.err.join("\n");
    expect(table).toContain("aaaa1111");
    expect(table).toContain("bbbb2222");
    expect(table).toContain("invoice one");
    expect(table).toContain("SESSION ID");
    // stdout carries the machine result only; a scripted caller must not receive box-drawing.
    expect(printed.outLines).toEqual([]);
});

test("NEGATIVE CONTROL: a resolved resume prints no candidate table", async () => {
    const printed = capturePrinted();

    expect(
        await selectResumeSession({
            adapter: adapter([session("aaaa1111", "invoice one")]),
            query: "invoice",
            interactive: false,
        })
    ).toBeDefined();
    expect(printed.err).toEqual([]);
    expect(printed.outLines).toEqual([]);
});

/** An adapter that records how many times the transcript search actually ran. */
function countingAdapter(
    sessions: AgentSession[],
    content: AgentSession[] = []
): { adapter: AgentSessionAdapter; searches: () => number } {
    let searches = 0;

    return {
        adapter: {
            kind: "codex",
            list: async () => sessions,
            search: async () => {
                searches += 1;
                return content;
            },
        },
        searches: () => searches,
    };
}

test("a weak title hit no longer suppresses the transcript pass, and both candidates are offered", async () => {
    // `title` falls back to the opening prompt, so a session merely NAMED after the query won the
    // metadata rung, suppressed the search entirely, and was then returned silently as the only
    // match. The session whose transcript actually discusses the subject was never offered.
    const named = session("11111111-1111-4111-8111-111111111111", "reports-02 rerun");
    const discussed = session("55555555-5555-4555-8555-555555555555", "untitled");
    const { adapter: counting, searches } = countingAdapter([named], [discussed]);

    await expect(selectResumeSession({ adapter: counting, query: "reports", interactive: false })).rejects.toThrow(
        "Ambiguous"
    );
    expect(searches()).toBe(1);
});

test("NEGATIVE CONTROL: an identifying match still skips the transcript pass", async () => {
    // The gate must not turn every resume into a full-text scan. A query that NAMES the session
    // resolves from metadata alone, which is what keeps resuming by id or exact title fast.
    const exact = session("66666666-6666-4666-8666-666666666666", "weekly rollup");
    const { adapter: counting, searches } = countingAdapter([exact], [session("other", "untitled")]);

    expect(await selectResumeSession({ adapter: counting, query: "weekly rollup", interactive: false })).toBe(exact);
    expect(searches()).toBe(0);
});

test("a session resolves by filePath and by sourceKey, which is what the recovery command passes", async () => {
    // `assertClaudeResumeHome` tells the user to rerun as `tools claude resume <filePath>
    // --all-projects`. With no identity rung for either field, the command the code itself
    // prints resolved nothing at all.
    const byPath = session("77777777-7777-4777-8777-777777777777", "untitled");
    const byKey = { ...session("88888888-8888-4888-8888-888888888888", "untitled"), sourceKey: "old-home:88888888" };
    const { adapter: counting, searches } = countingAdapter([byPath, byKey]);

    expect(await selectResumeSession({ adapter: counting, query: byPath.filePath, interactive: false })).toBe(byPath);
    expect(await selectResumeSession({ adapter: counting, query: "old-home:88888888", interactive: false })).toBe(
        byKey
    );
    expect(searches()).toBe(0);
});

test("a symlinked launch home still collapses onto its own copy", async () => {
    // `sourceHome` is stored realpath-resolved; the preferred home arrives raw. A bare string
    // compare made this collapse a silent no-op for a symlinked or `~`-spelled home, and the
    // query went back to reporting two copies of one session as ambiguous.
    const real = mkdtempSync(join(tmpdir(), "resume-home-"));
    const link = `${real}-link`;
    symlinkSync(real, link);

    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const local = { ...session(id, "astra-pricing"), sourceHome: realpathSync(real) };
    const retained = { ...session(id, "astra-pricing"), sourceHome: "/old-home" };

    expect(
        await selectResumeSession({
            adapter: adapter([retained, local]),
            query: "astra-pricing",
            // The caller passes the SYMLINK, which is what `CLAUDE_CONFIG_DIR` usually holds.
            preferredHome: link,
            interactive: false,
        })
    ).toBe(local);
});

test("a source home that cannot be resolved degrades to a string compare instead of aborting the resume", async () => {
    // `canonicalPath` swallows ENOENT and RETHROWS everything else, so a `sourceHome` reached
    // through a self-referential symlink (ELOOP), or under a directory answering EACCES, took
    // the whole resume down — a failure the plain string compare this replaced could not
    // produce. Choosing the launch home's copy is a ranking, never a reason to refuse to resume.
    const dir = mkdtempSync(join(tmpdir(), "resume-loop-"));
    const loop = join(dir, "loop");
    symlinkSync(loop, loop);
    expect(() => realpathSync(loop)).toThrow();

    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const broken = { ...session(id, "astra-pricing"), sourceHome: loop };
    const local = { ...session(id, "astra-pricing"), sourceHome: realpathSync(dir) };

    expect(
        await selectResumeSession({
            adapter: adapter([broken, local]),
            query: "astra-pricing",
            preferredHome: dir,
            interactive: false,
        })
    ).toBe(local);
});

test("the metadata and content union counts one session once, so a single answer stays unambiguous", async () => {
    // The union this gate introduces can return the same session from both rungs. Without the
    // dedup that reads as two matches, and a query with exactly one answer starts refusing.
    //
    // 🛑 The `sourceKey` on both rows is load-bearing, not decoration. Every production row
    // carries one: `adapter.list()` and `adapter.search()` both end in `resultFromMetadata`
    // (./service.ts), which reads a NOT NULL column. A fixture without it falls through to the
    // `filePath` term and pins a branch production never takes — found by review round 4, which
    // deleted `session.sourceKey ??` from `dedupeSessions` and watched the whole file stay green.
    // The two rows deliberately differ in `filePath`, so identity is the only term that can
    // collapse them; the rungs do read that field from different projections.
    const id = "99999999-9999-4999-8999-999999999999";
    const listed = { ...session(id, "invoice draft"), sourceHome: "/home", sourceKey: sourceKeyFor("/home", id) };
    const found = { ...listed, filePath: "/home/projects/moved/99999999.jsonl" };
    const { adapter: counting, searches } = countingAdapter([listed], [found]);

    expect(await selectResumeSession({ adapter: counting, query: "invoice", interactive: false })).toBe(listed);
    expect(searches()).toBe(1);
});

test("two homes' copies of one session survive the dedup; the launch home is what collapses them", async () => {
    // 🛑 `historySourceKey` (./identity.ts) puts the realpath'd home INSIDE the key, so one
    // native session indexed from two homes has two DIFFERENT keys and `dedupeSessions` cannot
    // collapse it. `preferHomeCopies` does that, and only when the caller knows the launch home.
    // Both halves are pinned here because a dedup that looked like it already handled the
    // cross-home case would invite deleting `preferHomeCopies` and restoring the ambiguity.
    const printed = capturePrinted();
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const local = {
        ...session(id, "invoice draft"),
        sourceHome: "/home",
        sourceKey: sourceKeyFor("/home", id),
        filePath: "/home/sessions/bbbbbbbb.jsonl",
    };
    const retained = {
        ...session(id, "untitled"),
        sourceHome: "/old-home",
        sourceKey: sourceKeyFor("/old-home", id),
        filePath: "/old-home/sessions/bbbbbbbb.jsonl",
    };

    // The metadata rung finds one copy by title and the content rung the other, so both reach
    // the dedup. With no preferred home there is nothing to choose between them.
    await expect(
        selectResumeSession({
            adapter: countingAdapter([local], [retained]).adapter,
            query: "invoice",
            interactive: false,
        })
    ).rejects.toThrow("Ambiguous codex resume (2 matches)");
    expect(printed.err.join("\n")).toContain("SESSION ID");

    expect(
        await selectResumeSession({
            adapter: countingAdapter([local], [retained]).adapter,
            query: "invoice",
            preferredHome: "/home",
            interactive: false,
        })
    ).toBe(local);
});

test("a home is canonicalized once per DISTINCT home, not twice per indexed session", async () => {
    // `canonicalPath` hits the filesystem, and `preferHomeCopies` asks about every row twice.
    // The title rung filters a listing with no row limit, so resolving per row paid 2N
    // `realpath` walks for what is, in practice, one or two distinct homes.
    capturePrinted();
    const canonical = spyOn(paths, "canonicalPath");
    const sessions = [
        ...Array.from({ length: 20 }, (_, index) => ({
            ...session(`launch-${index}`, `invoice ${index}`),
            sourceHome: "/launch-home",
        })),
        ...Array.from({ length: 20 }, (_, index) => ({
            ...session(`retained-${index}`, `invoice ${index}`),
            sourceHome: "/retained-home",
        })),
    ];

    try {
        await expect(
            selectResumeSession({
                adapter: adapter(sessions),
                query: "invoice",
                preferredHome: "/launch-home",
                interactive: false,
            })
        ).rejects.toThrow("Ambiguous");

        // One for the preferred home, one for each distinct `sourceHome` a row carries.
        expect(new Set(canonical.mock.calls.map(([home]) => home))).toEqual(
            new Set(["/launch-home", "/retained-home"])
        );
        expect(canonical.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
        canonical.mockRestore();
    }
});
