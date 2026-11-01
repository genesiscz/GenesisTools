import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCodexLocate } from "@genesiscz/utils/agent-sessions/readers/codex-locate";
import { harnessDriver } from "@genesiscz/utils/ai/providers/harness-index";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { codexHomesWithLegacy, nativeSessionRootsWithLegacyHomes } from "@genesiscz/utils/providers/session-paths";
import {
    directReads,
    type FolderReads,
    resolveCodexNative,
    resolveTranscript,
    resolveTranscripts,
    resolveTranscriptsWith,
    type TranscriptRoots,
} from "./resolve";
import { listDir, mtimeOf, rescanWorkerTurns } from "./resolve-core";

function fixtureRoot(): string {
    return mkdtempSync(join(tmpdir(), "gt-transcript-"));
}

/** The fixture folders, named flat, as the per-harness roots a lookup takes. */
function harnessRoots(dirs: {
    claudeProjects?: string;
    claudeWorker?: string;
    grokHome?: string;
    grokWorker?: string;
    codexHome?: string;
    codexWorker?: string;
}): TranscriptRoots {
    const entry = (native: string | undefined, worker: string | undefined) => ({
        ...(native ? { native: [native] } : {}),
        ...(worker ? { worker } : {}),
    });

    return {
        claude: entry(dirs.claudeProjects, dirs.claudeWorker),
        codex: entry(dirs.codexHome, dirs.codexWorker),
        grok: entry(dirs.grokHome, dirs.grokWorker),
    };
}

describe("resolveTranscript", () => {
    test("finds a grok native updates.jsonl by session id prefix", async () => {
        const root = fixtureRoot();
        const grokHome = join(root, "grok");
        const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001";
        const dir = join(grokHome, "sessions", encodeURIComponent("/tmp/proj"), sessionId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "updates.jsonl"), "{}\n");

        const hit = await resolveTranscript(
            sessionId.slice(0, 8),
            harnessRoots({
                grokHome,
                grokWorker: join(root, "empty-worker"),
                claudeProjects: join(root, "empty-claude"),
                codexHome: join(root, "empty-codex"),
                codexWorker: join(root, "empty-codex-w"),
            })
        );
        expect(hit.provider).toBe("grok");
        expect(hit.source).toBe("native");
        expect(hit.sessionId).toBe(sessionId);
        expect(hit.filePath).toBe(join(dir, "updates.jsonl"));
    });

    test("finds a grok worker session by name and lists turn logs", async () => {
        const root = fixtureRoot();
        const worker = join(root, "worker");
        mkdirSync(worker, { recursive: true });
        writeFileSync(
            join(worker, "demo.meta.json"),
            SafeJSON.stringify({
                name: "demo",
                sessionId: "sess-worker-1",
                cwd: "/tmp",
                workerHome: "/tmp",
                readOnly: true,
                turns: 2,
                createdAt: "2026-08-27T20:00:00.000Z",
            })
        );
        writeFileSync(join(worker, "demo.turn1.jsonl"), "{}\n");
        writeFileSync(join(worker, "demo.turn2.jsonl"), "{}\n");

        const hit = await resolveTranscript(
            "demo",
            harnessRoots({
                grokHome: join(root, "empty-grok"),
                grokWorker: worker,
                claudeProjects: join(root, "empty-claude"),
                codexHome: join(root, "empty-codex"),
                codexWorker: join(root, "empty-codex-w"),
            })
        );
        expect(hit.provider).toBe("grok");
        expect(hit.source).toBe("worker");
        expect(hit.filePath).toBe(join(worker, "demo.turn2.jsonl"));
        expect(hit.extraFiles).toEqual([join(worker, "demo.turn1.jsonl")]);
    });

    test("finds a codex native rollout by uuid in the filename", async () => {
        const root = fixtureRoot();
        const id = "ffffffff-1111-2222-3333-444444444444";
        const dir = join(root, "codex", "sessions", "2026", "08", "27");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `rollout-2026-08-27T20-00-00-${id}.jsonl`);
        writeFileSync(file, "{}\n");

        const hit = await resolveTranscript(
            id.slice(0, 8),
            harnessRoots({
                grokHome: join(root, "empty-grok"),
                grokWorker: join(root, "empty-worker"),
                claudeProjects: join(root, "empty-claude"),
                codexHome: join(root, "codex"),
                codexWorker: join(root, "empty-codex-w"),
            })
        );
        expect(hit.provider).toBe("codex");
        expect(hit.source).toBe("native");
        expect(hit.filePath).toBe(file);
        expect(hit.sessionId).toBe(id);
    });

    test("finds a compressed codex rollout (.jsonl.zst) and one directly in archived_sessions, with the thread id", async () => {
        const root = fixtureRoot();
        const roots = harnessRoots({
            grokHome: join(root, "empty-grok"),
            grokWorker: join(root, "empty-worker"),
            claudeProjects: join(root, "empty-claude"),
            codexHome: join(root, "codex"),
            codexWorker: join(root, "empty-codex-w"),
        });
        const compressed = "eeeeeeee-1111-2222-3333-444444444444";
        const dir = join(root, "codex", "sessions", "2026", "10", "01");
        mkdirSync(dir, { recursive: true });
        const zst = join(dir, `rollout-2026-10-01T09-00-00-${compressed}.jsonl.zst`);
        writeFileSync(zst, "not read here");
        const archived = "dddddddd-1111-2222-3333-444444444444";
        mkdirSync(join(root, "codex", "archived_sessions"), { recursive: true });
        const flat = join(root, "codex", "archived_sessions", `rollout-2026-03-10T20-11-50-${archived}.jsonl.zst`);
        writeFileSync(flat, "not read here");

        expect(await resolveTranscript(compressed.slice(0, 8), roots)).toMatchObject({
            provider: "codex",
            source: "native",
            filePath: zst,
            sessionId: compressed,
        });
        expect(await resolveTranscript(archived.slice(0, 8), roots)).toMatchObject({
            filePath: flat,
            sessionId: archived,
        });
    });

    test("finds a claude jsonl under an injected projects dir", async () => {
        const root = fixtureRoot();
        const id = "12345678-aaaa-bbbb-cccc-ddddeeee0001";
        const dir = join(root, "projects", "proj");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${id}.jsonl`);
        writeFileSync(file, "{}\n");

        const hit = await resolveTranscript(
            id,
            harnessRoots({
                grokHome: join(root, "empty-grok"),
                grokWorker: join(root, "empty-worker"),
                claudeProjects: join(root, "projects"),
                codexHome: join(root, "empty-codex"),
                codexWorker: join(root, "empty-codex-w"),
            })
        );
        expect(hit.provider).toBe("claude");
        expect(hit.filePath).toBe(file);
        expect(hit.sessionId).toBe(id);
    });

    test("throws when no provider has the id", async () => {
        const root = fixtureRoot();
        await expect(
            resolveTranscript(
                "zzzzzzzz-missing",
                harnessRoots({
                    grokHome: join(root, "empty-grok"),
                    grokWorker: join(root, "empty-worker"),
                    claudeProjects: join(root, "empty-claude"),
                    codexHome: join(root, "empty-codex"),
                    codexWorker: join(root, "empty-codex-w"),
                })
            )
        ).rejects.toThrow(/No session file/);
    });
});

describe("rescanWorkerTurns", () => {
    test("finds a turn file written after the session resolved", () => {
        // PR #341 review round 4, t2: follow tailed one fixed path, so the next
        // steer's turn file was never discovered.
        const dir = mkdtempSync(join(tmpdir(), "grok-worker-"));
        writeFileSync(join(dir, "task.turn1.jsonl"), "{}\n");

        const resolved = {
            provider: "grok" as const,
            source: "worker" as const,
            sessionId: "task",
            filePath: join(dir, "task.turn1.jsonl"),
        };

        expect(rescanWorkerTurns(resolved)).toEqual({ filePath: join(dir, "task.turn1.jsonl") });

        writeFileSync(join(dir, "task.turn2.jsonl"), "{}\n");

        expect(rescanWorkerTurns(resolved)).toEqual({
            filePath: join(dir, "task.turn2.jsonl"),
            extraFiles: [join(dir, "task.turn1.jsonl")],
        });
    });

    test("another worker whose name extends this one is not picked up", () => {
        // PR #341 review t6: the filter was startsWith(`${name}.turn`), so for
        // the worker "task" a DIFFERENT worker's "task.turnover.turn2.jsonl"
        // passed, turnNumber() read it as turn 2, and follow mode switched to
        // that session's transcript.
        const dir = mkdtempSync(join(tmpdir(), "grok-worker-"));
        writeFileSync(join(dir, "task.turn1.jsonl"), "{}\n");
        writeFileSync(join(dir, "task.turnover.turn2.jsonl"), "{}\n");
        writeFileSync(join(dir, "task.turn2.jsonl.bak"), "{}\n");

        const resolved = {
            provider: "grok" as const,
            source: "worker" as const,
            sessionId: "task",
            filePath: join(dir, "task.turn1.jsonl"),
        };

        expect(rescanWorkerTurns(resolved)).toEqual({ filePath: join(dir, "task.turn1.jsonl") });
    });

    test("the worker named by the extended prefix still finds its own turns", () => {
        // The negative control: "task.turnover" is a legitimate worker name and
        // must keep resolving, or the tightened filter has broken real sessions.
        const dir = mkdtempSync(join(tmpdir(), "grok-worker-"));
        writeFileSync(join(dir, "task.turnover.turn1.jsonl"), "{}\n");
        writeFileSync(join(dir, "task.turnover.turn2.jsonl"), "{}\n");

        expect(
            rescanWorkerTurns({
                provider: "grok",
                source: "worker",
                sessionId: "task.turnover",
                filePath: join(dir, "task.turnover.turn1.jsonl"),
            })
        ).toEqual({
            filePath: join(dir, "task.turnover.turn2.jsonl"),
            extraFiles: [join(dir, "task.turnover.turn1.jsonl")],
        });
    });

    test("a native session has no turn sequence to rescan", () => {
        expect(
            rescanWorkerTurns({
                provider: "grok",
                source: "native",
                sessionId: "s",
                filePath: "/tmp/whatever/updates.jsonl",
            })
        ).toBeNull();
    });
});

describe("resolveTranscript: sub-agent ids and absolute paths", () => {
    function roots(root: string) {
        return harnessRoots({
            claudeProjects: join(root, "claude"),
            claudeWorker: join(root, "claude-w"),
            grokHome: join(root, "grok"),
            grokWorker: join(root, "grok-w"),
            codexHome: join(root, "codex"),
            codexWorker: join(root, "codex-w"),
        });
    }

    function subagentFile(root: string, agentId: string): string {
        const dir = join(root, "claude", "-tmp-proj", "11111111-2222-3333-4444-555555555555", "subagents");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `agent-${agentId}.jsonl`);
        writeFileSync(file, "{}\n");
        return file;
    }

    test("a teammate's sub-agent id finds its agent-<id>.jsonl, with or without the agent- prefix", async () => {
        const root = fixtureRoot();
        const file = subagentFile(root, "aworker-one-0123456789abcdef");

        for (const query of ["aworker-one-0123456789abcdef", "agent-aworker-one-0123456789abcdef"]) {
            const hit = await resolveTranscript(query, roots(root));
            expect(hit).toEqual({
                provider: "claude",
                source: "native",
                sessionId: "aworker-one-0123456789abcdef",
                filePath: file,
                extraFiles: undefined,
            });
        }
    });

    test("an absolute sub-agent path resolves as claude from its location", async () => {
        const root = fixtureRoot();
        const file = subagentFile(root, "a0123456789abcdef");

        expect(await resolveTranscript(file, roots(root))).toEqual({
            provider: "claude",
            source: "native",
            sessionId: "a0123456789abcdef",
            filePath: file,
        });
    });

    test("absolute worker paths take their provider from the worker directory", async () => {
        const root = fixtureRoot();
        mkdirSync(join(root, "grok-w"), { recursive: true });
        mkdirSync(join(root, "codex-w"), { recursive: true });
        writeFileSync(join(root, "grok-w", "probe.turn1.jsonl"), "{}\n");
        writeFileSync(join(root, "grok-w", "probe.turn2.jsonl"), "{}\n");
        writeFileSync(join(root, "codex-w", "probe.jsonl"), "{}\n");

        const grok = await resolveTranscript(join(root, "grok-w", "probe.turn1.jsonl"), roots(root));
        expect(grok).toEqual({
            provider: "grok",
            source: "worker",
            sessionId: "probe",
            filePath: join(root, "grok-w", "probe.turn2.jsonl"),
            extraFiles: [join(root, "grok-w", "probe.turn1.jsonl")],
        });

        const codex = await resolveTranscript(join(root, "codex-w", "probe.jsonl"), roots(root));
        expect(codex).toMatchObject({ provider: "codex", source: "worker", sessionId: "probe" });
    });

    test("absolute native paths take their provider and id from the root they live under", async () => {
        const root = fixtureRoot();
        const thread = "019a0000-1111-7222-8333-444455556666";
        const rollout = join(
            root,
            "codex",
            "sessions",
            "2026",
            "10",
            "30",
            `rollout-2026-10-30T10-00-00-${thread}.jsonl`
        );
        const updates = join(root, "grok", "sessions", "-tmp-proj", "grok-session-1", "updates.jsonl");
        const turn = join(root, "claude-w", "probe.turn1.jsonl");

        for (const file of [rollout, updates, turn]) {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, "{}\n");
        }

        expect(await resolveTranscript(rollout, roots(root))).toEqual({
            provider: "codex",
            source: "native",
            sessionId: thread,
            filePath: rollout,
        });
        expect(await resolveTranscript(updates, roots(root))).toEqual({
            provider: "grok",
            source: "native",
            sessionId: "grok-session-1",
            filePath: updates,
        });
        expect(await resolveTranscript(turn, roots(root))).toMatchObject({
            provider: "claude",
            source: "worker",
            sessionId: "probe",
            filePath: turn,
        });
    });

    test("an absolute path under no known root needs a provider", async () => {
        const root = fixtureRoot();
        const stray = join(root, "elsewhere.jsonl");
        writeFileSync(stray, "{}\n");

        await expect(resolveTranscript(stray, roots(root))).rejects.toThrow("no known transcript root");
        expect(await resolveTranscript(stray, roots(root), "claude")).toMatchObject({
            provider: "claude",
            sessionId: "elsewhere",
            filePath: stray,
        });
    });
});

/** Every provider and source in one tree, so a lookup change is checked against all of them at once. */
function mixedTree() {
    const root = fixtureRoot();
    const dirs = {
        claudeProjects: join(root, "claude"),
        claudeWorker: join(root, "claude-worker"),
        grokHome: join(root, "grok"),
        grokWorker: join(root, "grok-worker"),
        codexHome: join(root, "codex"),
        codexWorker: join(root, "codex-worker"),
    };
    const write = (path: string, text = "{}\n", mtimeSec?: number) => {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, text);
        if (mtimeSec !== undefined) {
            utimesSync(path, mtimeSec, mtimeSec);
        }

        return path;
    };
    const claudeId = "11111111-2222-3333-4444-555555555555";
    const twinId = "99999999-2222-3333-4444-555555555555";
    const files = {
        claude: write(join(dirs.claudeProjects, "-proj-a", `${claudeId}.jsonl`)),
        // The same session id under two projects: the newer file is the answer.
        twinOld: write(join(dirs.claudeProjects, "-proj-a", `${twinId}.jsonl`), "{}\n", 1_000),
        twinNew: write(join(dirs.claudeProjects, "-proj-b", `${twinId}.jsonl`), "{}\n", 2_000),
        subagent: write(join(dirs.claudeProjects, "-proj-a", claudeId, "subagents", "agent-a0564229bc9945515.jsonl")),
        grok: write(
            join(
                dirs.grokHome,
                "sessions",
                encodeURIComponent("/tmp/p"),
                "aaaaaaaa-0000-0000-0000-00000000000a",
                "updates.jsonl"
            )
        ),
        codex: write(
            join(
                dirs.codexHome,
                "sessions",
                "2026",
                "10",
                "12",
                "rollout-2026-10-12T10-00-00-bbbbbbbb-0000-0000-0000-00000000000b.jsonl"
            )
        ),
        codexWorker: write(join(dirs.codexWorker, "cw-task.jsonl")),
        claudeWorkerTurn1: write(join(dirs.claudeWorker, "cl-task.turn1.jsonl")),
        claudeWorkerTurn2: write(join(dirs.claudeWorker, "cl-task.turn2.jsonl")),
    };
    write(
        join(dirs.codexWorker, "cw-task.meta.json"),
        SafeJSON.stringify({ threadId: "cccccccc-0000-0000-0000-00000000000c" })
    );
    write(
        join(dirs.claudeWorker, "cl-task.meta.json"),
        SafeJSON.stringify({ sessionId: "dddddddd-0000-0000-0000-00000000000d" })
    );
    // A project folder with no transcripts and a stray file at the projects root must not break the walk.
    mkdirSync(join(dirs.claudeProjects, "-proj-empty"), { recursive: true });
    write(join(dirs.claudeProjects, "stray.txt"), "x");

    return { roots: harnessRoots(dirs), files, claudeId, twinId };
}

/** The queries the hub sends, each with the file it must find, or null for "no session file". */
function mixedQueries(tree: ReturnType<typeof mixedTree>): Array<[string, string | null]> {
    const { files, claudeId, twinId } = tree;

    return [
        [claudeId, files.claude],
        [claudeId.slice(0, 8), files.claude],
        [twinId, files.twinNew],
        ["a0564229bc9945515", files.subagent],
        ["agent-a0564229bc9945515", files.subagent],
        ["aaaaaaaa", files.grok],
        ["bbbbbbbb-0000-0000-0000-00000000000b", files.codex],
        ["cccccccc-0000-0000-0000-00000000000c", files.codexWorker],
        ["cw-task", files.codexWorker],
        ["dddddddd-0000-0000-0000-00000000000d", files.claudeWorkerTurn2],
        ["eeeeeeee-0000-0000-0000-00000000000e", null],
    ];
}

describe("resolveTranscript: one tree with every provider", () => {
    test("each id finds its file, the newer of two same-id files wins, and a missing id throws", async () => {
        const tree = mixedTree();

        for (const [query, expected] of mixedQueries(tree)) {
            if (expected === null) {
                await expect(resolveTranscript(query, tree.roots)).rejects.toThrow(
                    `No session file found for "${query}"`
                );
                continue;
            }

            const hit = await resolveTranscript(query, tree.roots);
            expect({ query, filePath: hit.filePath }).toEqual({ query, filePath: expected });
        }

        const worker = await resolveTranscript("cl-task", tree.roots);
        expect(worker.extraFiles).toEqual([tree.files.claudeWorkerTurn1]);
    });

    test("a provider filter hides the other providers' files", async () => {
        const tree = mixedTree();

        await expect(resolveTranscript("aaaaaaaa", tree.roots, "claude")).rejects.toThrow("No session file found");
        expect((await resolveTranscript("aaaaaaaa", tree.roots, "grok")).provider).toBe("grok");
    });
});

describe("resolveTranscripts", () => {
    test("answers every id exactly as resolveTranscript answers it alone, errors included", async () => {
        const tree = mixedTree();
        const queries = mixedQueries(tree).map(([query]) => query);
        const batch = await resolveTranscripts([...queries, queries[0]], tree.roots);

        expect([...batch.keys()]).toEqual(queries);

        for (const query of queries) {
            const alone = await resolveTranscript(query, tree.roots).catch((err: Error) => err);
            expect({ query, answer: batch.get(query) }).toEqual({ query, answer: alone });
        }
    });

    test("a provider filter applies to the whole batch", async () => {
        const tree = mixedTree();
        const batch = await resolveTranscripts(["aaaaaaaa", tree.claudeId], tree.roots, "grok");

        expect(batch.get("aaaaaaaa")).toMatchObject({ provider: "grok", filePath: tree.files.grok });
        expect(batch.get(tree.claudeId)).toBeInstanceOf(Error);
    });

    function countingReads(): { reads: FolderReads; listed: Map<string, number> } {
        const listed = new Map<string, number>();
        return {
            listed,
            reads: {
                ...directReads,
                listDir: (path) => {
                    listed.set(path, (listed.get(path) ?? 0) + 1);
                    return directReads.listDir(path);
                },
            },
        };
    }

    test("a batch lists each session folder once, and the next call lists it again", () => {
        const tree = mixedTree();
        const queries = mixedQueries(tree).map(([query]) => query);
        const { reads, listed } = countingReads();

        resolveTranscriptsWith({ queries, roots: tree.roots, reads });
        const once = [...listed.values()];
        resolveTranscriptsWith({ queries, roots: tree.roots, reads });

        expect(queries.length).toBeGreaterThan(1);
        expect(once.length).toBeGreaterThan(0);
        expect(once.every((count) => count === 1)).toBe(true);
        expect([...listed.values()].every((count) => count === 2)).toBe(true);
    });

    test("a batch reads a harness's default roots once, and never for roots given in full", () => {
        const tree = mixedTree();
        const queries = mixedQueries(tree).map(([query]) => query);
        const locate = harnessDriver("codex").parts.locate;
        // Stubbed: the real defaults list this Mac's Codex homes, and the test only counts the calls.
        const defaults = spyOn(locate, "defaultRoots").mockImplementation(() => ({
            native: tree.roots.codex?.native ?? [],
            worker: tree.roots.codex?.worker ?? "",
        }));

        try {
            resolveTranscriptsWith({ queries, roots: tree.roots, reads: directReads });
            expect(defaults).toHaveBeenCalledTimes(0);

            // The worker folder left out: the defaults fill it, once for the whole batch.
            const partial: TranscriptRoots = { ...tree.roots, codex: { native: tree.roots.codex?.native } };
            resolveTranscriptsWith({ queries, roots: partial, reads: directReads });
            expect(queries.length).toBeGreaterThan(1);
            expect(defaults).toHaveBeenCalledTimes(1);
        } finally {
            defaults.mockRestore();
        }
    });

    test("an empty list reads nothing and answers nothing", () => {
        const { reads, listed } = countingReads();

        expect(resolveTranscriptsWith({ queries: [], roots: mixedTree().roots, reads }).size).toBe(0);
        expect(listed.size).toBe(0);
    });
});

test("a codex spawn worker's thread id resolves to the worker log, and resolveCodexNative to its rollout", async () => {
    // `tools codex wait <thread id>` refused a spawn worker because its newer event log won the id.
    const root = fixtureRoot();
    const id = "eeeeeeee-1111-2222-3333-444444444444";
    const dir = join(root, "codex", "sessions", "2026", "10", "13");
    mkdirSync(dir, { recursive: true });
    const rollout = join(dir, `rollout-2026-10-13T17-00-00-${id}.jsonl`);
    writeFileSync(rollout, "{}\n");
    const workers = join(root, "codex-w");
    mkdirSync(workers, { recursive: true });
    writeFileSync(join(workers, "reviewer.meta.json"), SafeJSON.stringify({ name: "reviewer", threadId: id }));
    writeFileSync(join(workers, "reviewer.jsonl"), "{}\n");
    utimesSync(rollout, new Date(1_000_000_000_000), new Date(1_000_000_000_000));
    const roots = harnessRoots({
        grokHome: join(root, "empty-grok"),
        grokWorker: join(root, "empty-worker"),
        claudeProjects: join(root, "empty-claude"),
        codexHome: join(root, "codex"),
        codexWorker: workers,
    });

    expect((await resolveTranscript(id, roots)).source).toBe("worker");
    expect(resolveCodexNative(id, roots)).toEqual({
        provider: "codex",
        source: "native",
        sessionId: id,
        filePath: rollout,
    });
    expect(resolveCodexNative("00000000-0000-0000-0000-000000000000", roots)).toBeNull();
});

test("native readers expose window turns and ignore malformed text blocks", async () => {
    const { claudeHistoryReader, codexHistoryReader, grokHistoryReader } = await import(
        "@genesiscz/utils/agent-sessions/compact-readers"
    );
    for (const reader of [claudeHistoryReader, codexHistoryReader, grokHistoryReader]) {
        expect(typeof reader.windowTurns).toBe("function");
    }
    const turns = claudeHistoryReader.windowTurns([
        { uuid: "bad", type: "user", message: { content: [{ type: "text" }] } },
        { uuid: "bad-assistant", type: "assistant", message: { content: [{ type: "text" }] } },
        { uuid: "bad-tool", type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "read" }] } },
        {
            uuid: "tool",
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "call", name: "Read", input: {} }] },
        },
        {
            uuid: "bad-result",
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "call", content: [null] }] },
        },
        { uuid: "good", type: "user", message: { content: "hello" } },
    ]);
    expect(turns.map((turn) => turn.id)).toEqual(["tool", "good"]);
});

test("a rollout in a legacy Codex profile home is found by id, as history discovery lists it", async () => {
    const home = fixtureRoot();
    const id = "ffffffff-1111-2222-3333-444444444444";
    const dir = join(home, ".codex-work", "sessions", "2026", "10", "31");
    mkdirSync(dir, { recursive: true });
    const rollout = join(dir, `rollout-2026-10-31T10-00-00-${id}.jsonl`);
    writeFileSync(rollout, "{}\n");

    await env.testing.withOverrides({ CODEX_HOME: undefined }, async () => {
        // One policy: the homes history discovery walks are the homes a lookup searches by default.
        const homes = codexHomesWithLegacy(home);
        expect(homes).toEqual([join(home, ".codex"), join(home, ".codex-work")]);
        expect(new Set(nativeSessionRootsWithLegacyHomes("codex", home))).toEqual(
            new Set(homes.flatMap((codexHome) => [join(codexHome, "sessions"), join(codexHome, "archived_sessions")]))
        );
        // The fixture home stands in for the user's, so the test never lists the real one.
        expect(createCodexLocate(home).defaultRoots().native).toEqual(homes);
        expect(await resolveTranscript(id, { codex: { native: homes } }, "codex")).toMatchObject({
            source: "native",
            filePath: rollout,
        });
    });
});

test("codex worker without home resolves a rollout in the default home list", async () => {
    const root = fixtureRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    const id = "eeeeeeee-1111-2222-3333-444444444444";
    const dir = join(second, "archived_sessions");
    mkdirSync(dir, { recursive: true });
    const rollout = join(dir, `rollout-2026-10-13T17-00-00-${id}.jsonl`);
    writeFileSync(rollout, "{}\n");
    const workerPath = join(root, "worker.jsonl");
    writeFileSync(workerPath, "{}\n");
    writeFileSync(join(root, "worker.meta.json"), SafeJSON.stringify({ threadId: id }));
    await env.testing.withOverrides({ CODEX_HOME: `${first},${second}` }, () => {
        expect(
            createCodexLocate(root).workerNative(
                { provider: "codex", source: "worker", sessionId: id, filePath: workerPath },
                directReads
            )
        ).toMatchObject({ source: "native", filePath: rollout });
        writeFileSync(join(root, "worker.meta.json"), SafeJSON.stringify({ threadId: id, home: "" }));
        expect(
            createCodexLocate(root).workerNative(
                { provider: "codex", source: "worker", sessionId: id, filePath: workerPath },
                directReads
            )
        ).toMatchObject({ source: "native", filePath: rollout });
        const explicitDir = join(first, "archived_sessions");
        mkdirSync(explicitDir, { recursive: true });
        const explicit = join(explicitDir, `rollout-2026-10-13T17-00-00-${id}.jsonl`);
        writeFileSync(explicit, "{}\n");
        writeFileSync(join(root, "worker.meta.json"), SafeJSON.stringify({ threadId: id, home: first }));
        expect(
            createCodexLocate(root).workerNative(
                { provider: "codex", source: "worker", sessionId: id, filePath: workerPath },
                directReads
            )
        ).toMatchObject({ source: "native", filePath: explicit });
    });
});

describe("listDir and mtimeOf", () => {
    test("a missing folder or file is a normal answer and writes no log line", () => {
        const root = fixtureRoot();
        const debug = spyOn(logger, "debug");
        try {
            expect(listDir(join(root, "no-subagents"))).toEqual([]);
            expect(mtimeOf(join(root, "no-transcript.jsonl"))).toBe(0);
            expect(debug).not.toHaveBeenCalled();
            // Any other failure is still logged: a file is not a folder.
            writeFileSync(join(root, "file"), "");
            expect(listDir(join(root, "file"))).toEqual([]);
            expect(debug).toHaveBeenCalledTimes(1);
        } finally {
            debug.mockRestore();
        }
    });
});
