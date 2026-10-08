import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postDecisions, readDecisions } from "@app/question/lib/decisions/store";
import { postAskForm } from "@app/question/lib/pending/ask";
import { openPendingStore } from "@app/question/lib/pending/store";
import { SafeJSON } from "@genesiscz/utils/json";
import { createWidgetHandoff } from "../widget/handoff";
import { readWidgetChanges, readWidgetDecisionEvents, type WidgetSources, widgetSnapshot } from "../widget/snapshot";
import { mutateWidgetState, readWidgetState } from "../widget/storage";
import { type WidgetTarget, widgetOutgoingSchema, widgetPreferencesSchema, widgetSessionKey } from "../widget/types";
import { widgetDispatcher } from "./dispatch";
import { processWidgetOutbox } from "./engine";
import { changeOutgoing, enqueueWidgetMessage, messageReadiness, recoverWidgetOutbox } from "./outbox";

const target: WidgetTarget = {
    hostId: "local",
    provider: "codex",
    sessionId: "sample-session",
    sourceHome: "/fixture/provider",
    cwd: "/fixture/project",
};
async function root() {
    return mkdtemp(join(tmpdir(), "widget-outbox-"));
}
async function enqueue(directory: string, text: string, destination = target, assetIds: string[] = []) {
    return enqueueWidgetMessage({
        root: directory,
        id: randomUUID(),
        target: destination,
        payload: { kind: "followup", text },
        assetIds,
    });
}

describe("durable widget outbox", () => {
    test("a slow enqueue preserves later typing and newly attached media", async () => {
        const directory = await root();
        const firstId = randomUUID();
        const laterId = randomUUID();
        await mutateWidgetState(directory, (state) => {
            state.assets[firstId] = {
                id: firstId,
                type: "image",
                path: "/fixture/one.png",
                name: "one.png",
                sha256: "a",
                mimeType: "image/png",
                width: 1,
                height: 1,
                bytes: 4,
            };
            state.drafts[widgetSessionKey(target)] = { text: "new typing", assetIds: [firstId, laterId] };
        });
        await enqueueWidgetMessage({
            root: directory,
            id: randomUUID(),
            target,
            payload: { kind: "followup", text: "original" },
            assetIds: [firstId],
            draftSnapshot: { text: "original", assetIds: [firstId] },
        });
        expect((await readWidgetState(directory)).drafts[widgetSessionKey(target)]).toEqual({
            text: "new typing",
            assetIds: [laterId],
        });
    });
    test("submit snapshots the target, clears only its draft, and deduplicates retries", async () => {
        const directory = await root();
        await mutateWidgetState(directory, (state) => {
            state.drafts[widgetSessionKey(target)] = { text: "first", assetIds: [] };
            state.drafts.other = { text: "keep", assetIds: [] };
        });
        const message = await enqueue(directory, "first");
        await enqueueWidgetMessage({ root: directory, ...message });
        const state = await readWidgetState(directory);
        expect(state.outgoing).toHaveLength(1);
        expect(state.drafts[widgetSessionKey(target)].text).toBe("");
        expect(state.drafts.other.text).toBe("keep");
        await expect(
            enqueueWidgetMessage({ root: directory, ...message, target: { ...target, sessionId: "another" } })
        ).rejects.toThrow("different message");
    });

    test("preparing video holds later text in its conversation while another conversation can send", async () => {
        const directory = await root();
        const videoId = randomUUID();
        await mutateWidgetState(directory, (state) => {
            state.assets[videoId] = {
                id: videoId,
                type: "video",
                name: "clip.mp4",
                path: "/fixture/clip.mp4",
                sha256: "fixture",
                durationUs: 1_000_000,
                width: 100,
                height: 100,
                settings: { fps: 1, framesPerImage: 4, minimumDifferencePct: 0 },
                revision: 1,
                status: "pending",
            };
        });
        const first = await enqueue(directory, "video", target, [videoId]);
        const second = await enqueue(directory, "later");
        const other = await enqueue(directory, "independent", { ...target, sessionId: "other-session" });
        const delivered: string[] = [];
        const dispatcher = {
            validate: async () => {},
            dispatch: async (message: { id: string }) => {
                delivered.push(message.id);
                return { delivered: true, channel: "fixture" };
            },
        };
        await processWidgetOutbox({ root: directory, dispatcher });
        expect(delivered).toEqual([other.id]);
        await changeOutgoing({ root: directory, id: first.id, action: "cancel" });
        await processWidgetOutbox({ root: directory, dispatcher });
        expect(delivered).toEqual([other.id, second.id]);
    });

    test("crash recovery and lost receipts never automatically resend", async () => {
        const directory = await root();
        const message = await enqueue(directory, "once");
        let calls = 0;
        const dispatcher = {
            validate: async () => {},
            dispatch: async () => {
                calls += 1;
                throw new Error("receipt lost after transport");
            },
        };
        await processWidgetOutbox({ root: directory, dispatcher });
        expect((await readWidgetState(directory)).outgoing[0].state).toBe("unknown");
        await recoverWidgetOutbox(directory);
        await processWidgetOutbox({ root: directory, dispatcher });
        expect(calls).toBe(1);
        await expect(changeOutgoing({ root: directory, id: message.id, action: "retry" })).rejects.toThrow("unknown");
        await mutateWidgetState(directory, (state) => {
            state.outgoing[0].state = "dispatching";
        });
        await recoverWidgetOutbox(directory);
        expect((await readWidgetState(directory)).outgoing[0].state).toBe("unknown");
    });

    test("cancellation during validation cannot cross the persisted dispatch boundary", async () => {
        const directory = await root();
        const message = await enqueue(directory, "cancel while resolving");
        let calls = 0;
        await processWidgetOutbox({
            root: directory,
            dispatcher: {
                validate: async () => changeOutgoing({ root: directory, id: message.id, action: "cancel" }),
                dispatch: async () => {
                    calls += 1;
                    return { delivered: true, channel: "fixture" };
                },
            },
        });
        expect(calls).toBe(0);
        expect((await readWidgetState(directory)).outgoing[0].state).toBe("cancelled");
    });

    test("changed attachment settings invalidate confirmation and cannot dispatch an old snapshot", async () => {
        const directory = await root();
        const assetId = randomUUID();
        await mutateWidgetState(directory, (state) => {
            state.assets[assetId] = {
                id: assetId,
                type: "image",
                path: "/fixture/image.png",
                name: "image.png",
                sha256: "fixture",
                mimeType: "image/png",
                width: 20,
                height: 20,
                bytes: 400,
            };
        });
        await enqueue(directory, "image", target, [assetId]);
        let calls = 0;
        await processWidgetOutbox({
            root: directory,
            dispatcher: {
                validate: async () => {
                    await mutateWidgetState(directory, (state) => {
                        state.assets[assetId].width = 30;
                    });
                },
                dispatch: async () => {
                    calls += 1;
                    return { delivered: true, channel: "fixture" };
                },
            },
        });
        expect(calls).toBe(0);
        const state = await readWidgetState(directory);
        state.assets[assetId] = {
            id: assetId,
            type: "video",
            path: "/fixture/video.mp4",
            name: "video.mp4",
            sha256: "fixture",
            width: 20,
            height: 20,
            durationUs: 1_000_000,
            settings: { fps: 1, framesPerImage: 4, minimumDifferencePct: 10 },
            revision: 2,
            confirmedRevision: 1,
            status: "ready",
            manifestPath: "/fixture/manifest.json",
        };
        expect(messageReadiness(state.outgoing[0], state)).toBe("review");
        state.assets[assetId].confirmedRevision = 2;
        expect(messageReadiness(state.outgoing[0], state)).toBe("queued");
    });

    test("a no-op read/reconcile does not rewrite state or create a watcher feedback loop", async () => {
        const directory = await root();
        expect((await readWidgetState(directory)).revision).toBe(0);
        await mutateWidgetState(directory, () => undefined);
        expect(await Bun.file(join(directory, "state.json")).exists()).toBe(false);
        await enqueue(directory, "saved");
        const before = await Bun.file(join(directory, "state.json")).text();
        await mutateWidgetState(directory, () => undefined);
        expect(await Bun.file(join(directory, "state.json")).text()).toBe(before);
    });
});

describe("widget source and delivery contracts", () => {
    test("decision ID, number, provider and revision must identify the same pending row", async () => {
        const directory = await root();
        const files = { file: join(directory, "decisions.jsonl"), events: join(directory, "events.jsonl") };
        const [one, two] = await postDecisions(
            files.file,
            files.events,
            {
                sessionId: target.sessionId,
                provider: "codex",
                decisions: [
                    { prompt: "First?", options: ["yes"] },
                    { prompt: "Second?", options: ["yes"] },
                ],
            },
            { env: {} }
        );
        let sends = 0;
        const dispatcher = widgetDispatcher({
            files,
            deliver: {
                codexWorkerFor: () => "fixture-worker",
                runTool: async () => {
                    sends++;
                    return { success: true, stdout: "", stderr: "" };
                },
            },
        });
        const message = widgetOutgoingSchema.parse({
            id: randomUUID(),
            target,
            assetIds: [],
            sequence: 1,
            createdAt: Date.now(),
            state: "queued",
            payload: { kind: "decision", id: one.id, number: two.number, expectedRevision: 1, option: "a" },
        });
        await expect(dispatcher.validate(message)).rejects.toThrow("changed");
        expect(sends).toBe(0);
        message.payload = {
            kind: "decision",
            id: one.id,
            number: one.number,
            expectedRevision: 1,
            option: "a",
            text: "",
        };
        await dispatcher.validate(message);
        const receipt = await dispatcher.dispatch(message, "");
        expect(receipt.delivered).toBe(true);
        expect(receipt.certainty).toBeUndefined();
        expect(sends).toBe(1);
        expect(readDecisions(files.file).find((row) => row.id === two.id)?.state).toBe("open");
        await expect(dispatcher.validate(message)).rejects.toThrow("changed");
    });

    test("a missing route leaves the canonical decision unmodified and never claims success", async () => {
        const directory = await root();
        const files = { file: join(directory, "decisions.jsonl"), events: join(directory, "events.jsonl") };
        const [row] = await postDecisions(
            files.file,
            files.events,
            {
                sessionId: target.sessionId,
                provider: "codex",
                decisions: [{ prompt: "Go?", options: ["yes"] }],
            },
            { env: {} }
        );
        const dispatcher = widgetDispatcher({
            files,
            deliver: {
                codexWorkerFor: () => null,
                runTool: async () => {
                    throw new Error("No transport may run");
                },
            },
        });
        const message = widgetOutgoingSchema.parse({
            id: randomUUID(),
            target,
            assetIds: [],
            sequence: 1,
            createdAt: Date.now(),
            state: "queued",
            payload: { kind: "decision", id: row.id, number: row.number, expectedRevision: 1, option: "a" },
        });
        await dispatcher.validate(message);
        expect((await dispatcher.dispatch(message, "")).delivered).toBe(false);
        expect(readDecisions(files.file)[0]).toEqual(row);
    });

    test("form ownership is checked and an earlier answer is not a receipt for a new answer", async () => {
        const directory = await root();
        const db = openPendingStore(join(directory, "questions.db"));
        const ask = { db, eventBase: directory, logBase: directory, notify: false, env: {}, ambient: false };
        try {
            const form = await postAskForm(
                {
                    projectPath: "/fixture/project",
                    sessionHint: target.sessionId,
                    items: [
                        {
                            id: "layout",
                            promptMarkdown: "Which layout?",
                            choices: [{ id: "compact", label: "Compact" }],
                        },
                    ],
                },
                ask
            );
            const dispatcher = widgetDispatcher({ ask });
            const message = widgetOutgoingSchema.parse({
                id: randomUUID(),
                target: { ...target, sessionId: "foreign" },
                assetIds: [],
                sequence: 1,
                createdAt: Date.now(),
                state: "queued",
                payload: { kind: "form", id: form.id, answers: [{ itemId: "layout", selectedChoices: ["compact"] }] },
            });
            await expect(dispatcher.validate(message)).rejects.toThrow("another session");
            message.target = target;
            await dispatcher.validate(message);
            expect((await dispatcher.dispatch(message, "<fromImage>fixture</fromImage>")).delivered).toBe(true);
            await expect(dispatcher.validate(message)).rejects.toThrow("already resolved");
            expect((await dispatcher.dispatch(message, "a different answer")).delivered).toBe(false);
        } finally {
            db.close();
        }
    });

    test("change receipts read the JSONL path and ignore other sessions", async () => {
        const directory = await root();
        const file = join(directory, "changes.jsonl");
        await writeFile(
            file,
            [
                SafeJSON.stringify({
                    session: target.sessionId,
                    path: "/fixture/a.ts",
                    ts: "2026-01-01T10:00:00Z",
                    source: "edit",
                }),
                "torn record",
                SafeJSON.stringify({ session: "another", path: "/fixture/foreign.ts", ts: "2026-01-01T11:00:00Z" }),
                SafeJSON.stringify({
                    session: target.sessionId,
                    path: "/fixture/a.ts",
                    ts: "2026-01-01T12:00:00Z",
                    source: "write",
                }),
            ].join("\n")
        );
        expect(readWidgetChanges({ target, path: file }).files).toEqual([
            { path: "/fixture/a.ts", at: "2026-01-01T12:00:00Z", source: "write" },
        ]);
    });

    test("filters hide presentation without changing pins or losing the selected-session query", async () => {
        const directory = await root();
        const key = widgetSessionKey(target);
        await mutateWidgetState(directory, (state) => {
            state.selectedKey = key;
            state.preferences.projects = ["/another-project"];
            state.preferences.showChanges = false;
        });
        const queried: string[] = [];
        const sources: WidgetSources = {
            sessions: async () => [
                {
                    ...target,
                    provider: "codex",
                    title: "Fixture session",
                    project: "Fixture",
                    cwdShort: "Fixture",
                    mtime: Date.now(),
                    model: null,
                    account: null,
                    filePath: "/fixture/transcript.jsonl",
                },
            ],
            decisions: () => [],
            forms: (session) => {
                if (session) {
                    queried.push(session);
                }
                return [];
            },
            answers: (session) => {
                if (session) {
                    queried.push(session);
                }
                return [];
            },
            agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
        };
        const snapshot = await widgetSnapshot({ root: directory, sources });
        expect(snapshot.sessions[0]).toMatchObject({ key, pinned: true, hiddenByFilter: true, visible: false });
        expect(queried).toEqual([target.sessionId, target.sessionId]);
        expect(snapshot.changes).toBeNull();
        expect(snapshot.errors).toEqual([]);
        await mutateWidgetState(directory, (state) => {
            state.preferences.projects = [];
            state.preferences.providers = ["claude"];
        });
        const providerHidden = await widgetSnapshot({ root: directory, sources });
        expect(providerHidden.sessions[0]).toMatchObject({ pinned: true, hiddenByFilter: true, visible: false });
        await mutateWidgetState(directory, (state) => {
            state.preferences.providers = ["codex"];
        });
        expect((await widgetSnapshot({ root: directory, sources })).sessions[0]?.visible).toBe(true);
    });
});

test("Decision events retain source timestamps and filter IDs before the display bound", async () => {
    const directory = await root();
    const file = join(directory, "events.jsonl");
    const wanted = { id: "d_1_fixture", ev: "updated", state: "acknowledged", ts: "2026-01-01T12:00:00Z" };
    const foreign = Array.from({ length: 110 }, (_, index) => ({ id: `other-${index}`, ev: "updated", ts: wanted.ts }));
    await writeFile(
        file,
        [SafeJSON.stringify(wanted), "corrupt", ...foreign.map((row) => SafeJSON.stringify(row))].join("\n")
    );
    const events = readWidgetDecisionEvents({ ids: [wanted.id], file });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sourceId: wanted.id, at: Date.parse(wanted.ts), body: "acknowledged" });
});

test("a separate handoff saves the unsent draft without dispatching or clearing it", async () => {
    const directory = await root();
    const key = widgetSessionKey(target);
    await mutateWidgetState(directory, (state) => {
        state.drafts[key] = { text: "Keep this independent from the original conversation", assetIds: [] };
        state.preferences.showChanges = false;
    });
    const sources: WidgetSources = {
        sessions: async () => [
            {
                ...target,
                provider: "codex",
                title: "Fixture task",
                project: "Fixture",
                cwdShort: "Fixture",
                mtime: Date.now(),
                model: null,
                account: null,
                filePath: "/fixture/no-transcript.jsonl",
            },
        ],
        decisions: () => [],
        forms: () => [],
        answers: () => [],
        agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
    };
    const result = await createWidgetHandoff({ root: directory, key, sources });
    expect(result.sent).toBe(false);
    expect(await readFile(result.path, "utf8")).toContain("Keep this independent");
    expect((await readWidgetState(directory)).drafts[key].text).toContain("Keep this independent");
    expect((await readWidgetState(directory)).outgoing).toHaveLength(0);
});

test("a handoff preserves an unsent video draft while frame preparation is incomplete", async () => {
    const directory = await root();
    const key = widgetSessionKey(target);
    const videoId = randomUUID();
    const source = join(directory, "original.mp4");
    await mutateWidgetState(directory, (state) => {
        state.drafts[key] = { text: "Inspect the original clip", assetIds: [videoId] };
        state.preferences.showChanges = false;
        state.assets[videoId] = {
            id: videoId,
            type: "video",
            name: "original.mp4",
            path: source,
            sha256: "fixture-video",
            durationUs: 1_000_000,
            width: 128,
            height: 80,
            settings: { fps: 2, framesPerImage: 16, minimumDifferencePct: 0 },
            revision: 1,
            status: "preparing",
        };
    });
    const sources: WidgetSources = {
        sessions: async () => [],
        decisions: () => [],
        forms: () => [],
        answers: () => [],
        agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
    };
    const result = await createWidgetHandoff({ root: directory, key, sources });
    const text = await readFile(result.path, "utf8");
    expect(text).toContain("Inspect the original clip");
    expect(text).toContain(`Original video (preparation incomplete): ${source}`);
    expect(result.sent).toBe(false);
    expect((await readWidgetState(directory)).drafts[key].assetIds).toEqual([videoId]);
    expect((await readWidgetState(directory)).outgoing).toHaveLength(0);
});

test("editing an unsent message restores its draft without reviving its cancelled send", async () => {
    const directory = await root();
    const message = await enqueue(directory, "Needs correction");
    await mutateWidgetState(directory, (state) => {
        state.outgoing[0].state = "failed";
    });
    await changeOutgoing({ root: directory, id: message.id, action: "edit" });
    const state = await readWidgetState(directory);
    expect(state.outgoing[0].state).toBe("cancelled");
    expect(state.drafts[widgetSessionKey(target)].text).toBe("Needs correction");
    await expect(changeOutgoing({ root: directory, id: message.id, action: "retry" })).rejects.toThrow("cancelled");
    const newer = await enqueue(directory, "newer");
    await mutateWidgetState(directory, (state) => {
        state.drafts[widgetSessionKey(target)] = { text: "another draft", assetIds: [] };
    });
    await expect(changeOutgoing({ root: directory, id: newer.id, action: "edit" })).rejects.toThrow("current draft");
});

test("a failing preflight cannot overwrite a concurrent cancellation", async () => {
    const directory = await root();
    const message = await enqueue(directory, "Cancel me");
    await processWidgetOutbox({
        root: directory,
        dispatcher: {
            validate: async () => {
                await changeOutgoing({ root: directory, id: message.id, action: "cancel" });
                throw new Error("stale source");
            },
            dispatch: async () => {
                throw new Error("No transport may run");
            },
        },
    });
    expect((await readWidgetState(directory)).outgoing[0].state).toBe("cancelled");
});

test("a resolved form remains in an external session timeline after leaving the waiting roster", async () => {
    const directory = await root();
    const external = { ...target, provider: "unknown" as const, sourceHome: "", sessionId: "external-question" };
    const key = widgetSessionKey(external);
    await mutateWidgetState(directory, (state) => {
        state.selectedKey = key;
        state.preferences.showChanges = false;
    });
    const sources: WidgetSources = {
        sessions: async () => [],
        decisions: () => [],
        answers: () => [],
        agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
        forms: (session) =>
            session === external.sessionId
                ? [
                      {
                          id: "external-form",
                          sessionHint: external.sessionId,
                          source: "Fixture source",
                          status: "answered",
                          createdAt: 1,
                          resolvedAt: 2,
                          projectPath: "/fixture/project",
                          cwd: "/fixture/project",
                          entryId: "answer-fixture",
                          items: [{ id: "one", promptMarkdown: "Choose", choices: [{ id: "yes", label: "Yes" }] }],
                          answers: { one: { itemId: "one", selectedChoices: ["yes"] } },
                      },
                  ]
                : [],
    };
    const snapshot = await widgetSnapshot({ root: directory, sources });
    expect(snapshot.sessions[0]).toMatchObject({ key, title: "Fixture source" });
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards[0]).toMatchObject({
        kind: "form",
        status: "answered",
        sessionKey: key,
        entryId: "answer-fixture",
    });
    expect(snapshot.cards[0].body).toContain("Yes");
});

test("new external answers and saved drafts remain discoverable while another session is selected", async () => {
    const directory = await root();
    await enqueue(directory, "Previously sent to this destination");
    const draftTarget = { ...target, sessionId: "draft-only" };
    await mutateWidgetState(directory, (state) => {
        state.selectedKey = widgetSessionKey({ ...target, sessionId: "elsewhere" });
        state.preferences.showChanges = false;
        state.drafts[widgetSessionKey(draftTarget)] = { text: "Retain this unfinished message", assetIds: [] };
    });
    const sources: WidgetSources = {
        sessions: async () => [],
        decisions: () => [],
        forms: () => [],
        agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
        answers: (session) =>
            session
                ? []
                : [
                      {
                          id: "incoming-answer",
                          ts: 3,
                          sessionId: "external-answer",
                          sessionTitle: "External screenshot",
                          project: "Fixture",
                          repoRoot: "/fixture",
                          cwd: "/fixture",
                          branch: null,
                          commitSha: null,
                          commitMessage: null,
                          agent: "unknown",
                          isWorktree: false,
                          worktreePath: null,
                          aiAgent: null,
                          agentLabel: null,
                          tag: "question",
                          question: "See the new screenshot",
                          answerMd: "Ready for inspection",
                          refs: [],
                          source: "mcp",
                          turnUuid: null,
                          supersededBy: null,
                          readAt: null,
                      },
                  ],
    };
    const snapshot = await widgetSnapshot({ root: directory, sources });
    expect(snapshot.sessions.map((session) => session.target.sessionId).sort()).toEqual(
        ["draft-only", "external-answer", target.sessionId].sort()
    );
    expect(snapshot.sessions.find((session) => session.target.sessionId === "external-answer")?.title).toBe(
        "External screenshot"
    );
    expect(snapshot.cards).toHaveLength(0);
    expect(snapshot.errors).toEqual([]);
});

test("a single preference edit preserves unrelated saved choices and rejects malformed values", async () => {
    const directory = await root();
    const before = widgetPreferencesSchema.parse({
        placement: "side",
        side: "left",
        display: "fixture-display",
        projects: ["/fixture/project"],
        sessions: ["fixture-session"],
        providers: ["codex"],
        topModules: ["capture", "shelf"],
        sideGroups: [["tasks"], ["agents"], ["capture"]],
        sideLayout: "separated",
        sidePosition: 0.2,
        hoverPreviews: false,
        glassEffect: false,
        voiceProvider: "local",
        voiceAccount: "fixture-account",
        voiceModel: "fixture-model",
        voiceLanguage: "cs",
    });
    await mutateWidgetState(directory, (state) => {
        state.preferences = before;
    });
    await performWidgetAction({ root: directory, input: { action: "preferences", patch: { showChanges: false } } });
    const changed = { ...before, showChanges: false };
    expect((await readWidgetState(directory)).preferences).toEqual(changed);
    await performWidgetAction({ root: directory, input: { action: "preferences", patch: {} } });
    expect((await readWidgetState(directory)).preferences).toEqual(changed);
    await expect(
        performWidgetAction({ root: directory, input: { action: "preferences", patch: { sidePosition: -1 } } })
    ).rejects.toThrow();
    expect((await readWidgetState(directory)).preferences).toEqual(changed);
    await performWidgetAction({
        root: directory,
        input: {
            action: "preferences",
            patch: { voiceAccount: null, voiceLanguage: "", projects: [], glassEffect: true },
        },
    });
    expect((await readWidgetState(directory)).preferences).toEqual({
        ...changed,
        voiceAccount: null,
        voiceLanguage: "",
        projects: [],
        glassEffect: true,
    });
});

test("legacy preferences gain independent module layouts without accepting off-screen positions", () => {
    const preferences = widgetPreferencesSchema.parse({ placement: "side" });
    expect(preferences.sideStyle).toBe("modular");
    expect(preferences.joinedEdges).toBe(true);
    expect(widgetPreferencesSchema.parse({ sideStyle: "classic", joinedEdges: false }).joinedEdges).toBe(false);
    expect(widgetPreferencesSchema.safeParse({ sideStyle: "unknown" }).success).toBe(false);
    expect(preferences.topModules).toEqual(["agents"]);
    expect(preferences.sideGroups).toHaveLength(3);
    expect(preferences.sidePosition).toBe(0.5);
    expect(preferences.hoverPreviews).toBe(true);
    expect(widgetPreferencesSchema.safeParse({ sidePosition: -1 }).success).toBe(false);
    expect(widgetPreferencesSchema.safeParse({ sideGroups: [["agents"]] }).success).toBe(false);
    expect(widgetPreferencesSchema.safeParse({ topModules: ["../../invalid"] }).success).toBe(false);
});

test("an open TODO does not mark its session as waiting for an answer", async () => {
    const directory = await root();
    const file = join(directory, "decisions.jsonl");
    const events = join(directory, "events.jsonl");
    await postDecisions(
        file,
        events,
        {
            sessionId: "todo-session",
            provider: "codex",
            decisions: [{ type: "todo", prompt: "Ship the follow-up", options: [] }],
        },
        { env: {} }
    );
    const sources: WidgetSources = {
        sessions: async () => [],
        decisions: () => readDecisions(file),
        forms: () => [],
        answers: () => [],
        agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
    };
    const todoOnly = await widgetSnapshot({ root: directory, sources });
    expect(todoOnly.cards[0]?.kind).toBe("todo");
    expect(todoOnly.sessions[0]?.status).toBe("recent");
    await postDecisions(
        file,
        events,
        { sessionId: "todo-session", provider: "codex", decisions: [{ prompt: "Proceed?", options: ["yes"] }] },
        { env: {} }
    );
    const needsAnswer = await widgetSnapshot({ root: directory, sources });
    expect(needsAnswer.sessions[0]?.status).toBe("waiting");
});
