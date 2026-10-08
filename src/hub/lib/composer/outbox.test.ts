import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as files from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DeliveryUnknownError } from "@app/question/lib/decisions/deliver";
import { postDecisions, readDecisions } from "@app/question/lib/decisions/store";
import { postAskForm } from "@app/question/lib/pending/ask";
import { getForm, listFormsSnapshot, openPendingStore } from "@app/question/lib/pending/store";
import * as transcripts from "@genesiscz/utils/ai/transcripts";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import * as commands from "@genesiscz/utils/process/bounded-command";
import * as fileLock from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import * as videos from "@genesiscz/utils/video/probe";
import { createCanvas } from "@napi-rs/canvas";
import { performWidgetAction } from "../widget/actions";
import { readWidgetReceiptContext } from "../widget/context";
import { createWidgetHandoff } from "../widget/handoff";
import {
    attachShelfItem,
    captureShelfImage,
    importShelfFile,
    listWidgetShelf,
    readShelfAttachment,
    removeShelfItem,
    stageShelfImage,
} from "../widget/shelf";
import {
    readWidgetChanges,
    readWidgetDecisionEvents,
    type WidgetSources,
    widgetForms,
    widgetSnapshot,
} from "../widget/snapshot";
import { MAX_WIDGET_STATE_BYTES, mutateWidgetState, readWidgetState } from "../widget/storage";
import {
    shownOutgoing,
    type WidgetAsset,
    type WidgetOutgoing,
    type WidgetTarget,
    widgetOutgoingSchema,
    widgetPreferencesSchema,
    widgetSessionKey,
} from "../widget/types";
import { importWidgetAsset, reviseVideoAsset } from "./assets";
import { widgetDeliveryReceipt, widgetDispatcher } from "./dispatch";
import { processWidgetOutbox } from "./engine";
import { changeOutgoing, enqueueWidgetMessage, messageReadiness, recoverWidgetOutbox } from "./outbox";
import { serializeWidgetMessage } from "./serialize";

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

    test("a shutdown during validation leaves the message queued and attempts nothing", async () => {
        const directory = await root();
        await enqueue(directory, "shutdown while resolving");
        const controller = new AbortController();
        let calls = 0;
        await processWidgetOutbox({
            root: directory,
            signal: controller.signal,
            dispatcher: {
                validate: async () => {
                    controller.abort();
                },
                dispatch: async () => {
                    calls += 1;
                    return { delivered: true, channel: "fixture" };
                },
            },
        });
        expect(calls).toBe(0);
        expect((await readWidgetState(directory)).outgoing[0].state).toBe("queued");
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
        await expect(dispatcher.validate(message, [])).rejects.toThrow("changed");
        expect(sends).toBe(0);
        message.payload = {
            kind: "decision",
            id: one.id,
            number: one.number,
            expectedRevision: 1,
            option: "a",
            text: "",
        };
        await dispatcher.validate(message, []);
        const receipt = await dispatcher.dispatch(message, "", []);
        expect(receipt.delivered).toBe(true);
        expect(receipt.certainty).toBeUndefined();
        expect(sends).toBe(1);
        expect(readDecisions(files.file).find((row) => row.id === two.id)?.state).toBe("open");
        // A delivered answer settles a repeat of the same message without typing it again.
        await dispatcher.validate(message, []);
        expect(await dispatcher.dispatch(message, "", [])).toMatchObject({ delivered: true, channel: "decisions" });
        expect(sends).toBe(1);
        // Another answer to the same decision is not this message's.
        await expect(
            dispatcher.validate({ ...message, payload: { ...message.payload, option: "b" } }, [])
        ).rejects.toThrow("changed");
    });

    test("a refused transport keeps the stored answer, and a Retry sends that same answer", async () => {
        const directory = await root();
        const files = { file: join(directory, "decisions.jsonl"), events: join(directory, "events.jsonl") };
        const [row] = await postDecisions(
            files.file,
            files.events,
            { sessionId: target.sessionId, provider: "codex", decisions: [{ prompt: "Go?", options: ["yes", "no"] }] },
            { env: {} }
        );
        let accept = false;
        const typed: string[][] = [];
        const dispatcher = widgetDispatcher({
            files,
            deliver: {
                codexWorkerFor: () => "fixture-worker",
                runTool: async (args) => {
                    typed.push(args);
                    return { success: accept, stdout: "", stderr: accept ? "" : "worker gone" };
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
            payload: { kind: "decision", id: row.id, number: row.number, expectedRevision: 1, option: "b" },
        });
        await dispatcher.validate(message, []);
        expect(await dispatcher.dispatch(message, "", [])).toMatchObject({ delivered: false, certainty: "not-sent" });
        expect(readDecisions(files.file)[0]?.state).toBe("answered");

        accept = true;
        await dispatcher.validate(message, []);
        expect((await dispatcher.dispatch(message, "", [])).delivered).toBe(true);
        expect(typed).toHaveLength(2);
        expect(readDecisions(files.file)[0]).toMatchObject({ state: "sent", option: "b" });
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
        await dispatcher.validate(message, []);
        expect((await dispatcher.dispatch(message, "", [])).delivered).toBe(false);
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
            await expect(dispatcher.validate(message, [])).rejects.toThrow("another session");
            message.target = target;
            await dispatcher.validate(message, []);
            expect((await dispatcher.dispatch(message, "<fromImage>fixture</fromImage>", [])).delivered).toBe(true);
            await expect(dispatcher.validate(message, [])).rejects.toThrow("already resolved");
            expect((await dispatcher.dispatch(message, "a different answer", [])).delivered).toBe(false);
        } finally {
            db.close();
        }
    });

    test("an image-only answer satisfies a required image item and is recorded with the image", async () => {
        const directory = await root();
        const db = openPendingStore(join(directory, "questions.db"));
        const ask = { db, eventBase: directory, logBase: directory, notify: false, env: {}, ambient: false };
        try {
            const form = await postAskForm(
                {
                    projectPath: "/fixture/project",
                    sessionHint: target.sessionId,
                    items: [
                        { id: "shot", promptMarkdown: "Show the bug", allowFreeText: false, allowImagePaste: true },
                    ],
                },
                ask
            );
            const imagePath = join(directory, "shot.png");
            await writeFile(imagePath, createCanvas(2, 2).toBuffer("image/png"));
            const image: WidgetAsset = {
                id: randomUUID(),
                type: "image",
                name: "shot.png",
                path: imagePath,
                sha256: "fixture-image",
                mimeType: "image/png",
                width: 2,
                height: 2,
                bytes: 0,
            };
            const dispatcher = widgetDispatcher({ ask });
            const message = widgetOutgoingSchema.parse({
                id: randomUUID(),
                target,
                assetIds: [image.id],
                sequence: 1,
                createdAt: Date.now(),
                state: "queued",
                payload: { kind: "form", id: form.id, answers: [{ itemId: "shot" }] },
            });
            await expect(dispatcher.validate(message, [])).rejects.toThrow();
            await dispatcher.validate(message, [image]);
            expect((await dispatcher.dispatch(message, "<fromImage>shot</fromImage>", [image])).delivered).toBe(true);
            const recorded = getForm(db, form.id);
            expect(recorded?.status).toBe("answered");
            expect(recorded?.answers?.shot?.images?.map((entry) => entry.name)).toEqual(["shot.png"]);
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

test("a handoff keeps the draft and the transcript path when the transcript cannot be read", async () => {
    const directory = await root();
    const key = widgetSessionKey(target);
    const transcriptPath = join(directory, "unreadable.jsonl");
    await writeFile(transcriptPath, "{ not a transcript");
    await mutateWidgetState(directory, (state) => {
        state.drafts[key] = { text: "Keep this draft even without a summary", assetIds: [] };
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
                filePath: transcriptPath,
            },
        ],
        decisions: () => [],
        forms: () => [],
        answers: () => [],
        agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
    };
    const resolver = spyOn(transcripts, "resolveTranscript").mockRejectedValue(new Error("unexpected format"));
    try {
        const result = await createWidgetHandoff({ root: directory, key, sources });
        const text = await readFile(result.path, "utf8");
        expect(resolver).toHaveBeenCalledTimes(1);
        expect(text).toContain("Keep this draft even without a summary");
        expect(text).toContain(`Original transcript: ${transcriptPath}`);
        expect(result.sent).toBe(false);
    } finally {
        resolver.mockRestore();
    }
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

const emptySources: WidgetSources = {
    sessions: async () => [],
    decisions: () => [],
    forms: () => [],
    answers: () => [],
    agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
};

function readyVideo(id: string, manifestPath: string): WidgetAsset {
    return {
        id,
        type: "video",
        name: "clip.mp4",
        path: `/fixture/${id}.mp4`,
        sha256: "fixture-video",
        durationUs: 1_000_000,
        width: 128,
        height: 80,
        settings: { fps: 2, framesPerImage: 16, minimumDifferencePct: 0 },
        revision: 1,
        confirmedRevision: 1,
        status: "ready",
        manifestPath,
    };
}

test("a handoff keeps a ready video's original path when its frame manifest cannot be read", async () => {
    const directory = await root();
    const key = widgetSessionKey(target);
    const videoId = randomUUID();
    await mutateWidgetState(directory, (state) => {
        state.drafts[key] = { text: "Look at the clip", assetIds: [videoId] };
        state.preferences.showChanges = false;
        state.assets[videoId] = readyVideo(videoId, join(directory, "missing-manifest.json"));
    });
    const result = await createWidgetHandoff({ root: directory, key, sources: emptySources });
    const text = await readFile(result.path, "utf8");
    expect(text).toContain("Look at the clip");
    expect(text).toContain(`Original video (frame evidence unavailable): /fixture/${videoId}.mp4`);
    expect(result.sent).toBe(false);
});

test("malformed stored times sort as the oldest activity instead of breaking the snapshot", async () => {
    const directory = await root();
    const file = join(directory, "decisions.jsonl");
    await postDecisions(
        file,
        join(directory, "events.jsonl"),
        { sessionId: "time-session", provider: "codex", decisions: [{ prompt: "Proceed?", options: ["yes"] }] },
        { env: {} }
    );
    const snapshot = await widgetSnapshot({
        root: directory,
        sources: {
            ...emptySources,
            decisions: () => readDecisions(file).map((row) => ({ ...row, updatedTs: "not a time" })),
        },
    });
    expect(snapshot.sessions[0]?.activityAt).toBe(0);
    expect(snapshot.cards[0]?.at).toBe(0);
    const wire = SafeJSON.stringify(snapshot);
    expect(wire).not.toContain('"activityAt":null');
    expect(wire).not.toContain('"at":null');
});

test("a change that would push widget history past the read limit is refused and the stored state stays readable", async () => {
    const directory = await root();
    await enqueue(directory, "Kept");
    await expect(
        mutateWidgetState(directory, (state) => {
            state.drafts[widgetSessionKey(target)] = { text: "small", assetIds: [] };
            const id = randomUUID();
            state.assets[id] = readyVideo(id, "x".repeat(MAX_WIDGET_STATE_BYTES));
        })
    ).rejects.toThrow("exceed 32 MiB");
    const state = await readWidgetState(directory);
    expect(state.outgoing.map((message) => message.payload.text)).toEqual(["Kept"]);
    expect(Object.keys(state.assets)).toHaveLength(0);
    await changeOutgoing({ root: directory, id: state.outgoing[0].id, action: "cancel" });
    expect((await readWidgetState(directory)).outgoing[0].state).toBe("cancelled");
});

test("an unhinted pending form keeps its card when the widget selects the session named after it", async () => {
    const directory = await root();
    const dbPath = join(directory, "questions.db");
    const db = openPendingStore(dbPath);
    let formId = "";
    try {
        const form = await postAskForm(
            {
                projectPath: "/fixture/project",
                items: [{ id: "pick", promptMarkdown: "Which one?", choices: [{ id: "a", label: "A" }] }],
            },
            { db, eventBase: directory, logBase: directory, notify: false, env: {}, ambient: false }
        );
        formId = form.id;
        expect(form.sessionHint).toBeUndefined();
    } finally {
        db.close();
    }
    const sources: WidgetSources = {
        ...emptySources,
        forms: (sessionHint) => widgetForms({ dbPath, sessionHint }),
    };
    const roster = await widgetSnapshot({ root: directory, sources });
    const session = roster.sessions.find((entry) => entry.target.sessionId === formId);
    expect(session?.status).toBe("waiting");
    await mutateWidgetState(directory, (state) => {
        state.selectedKey = session?.key ?? null;
        state.preferences.showChanges = false;
    });
    const selected = await widgetSnapshot({ root: directory, sources });
    expect(selected.cards.map((card) => card.id)).toEqual([`form:${formId}`]);
    expect(listFormsSnapshot({ dbPath, opts: { sessionHint: formId } })).toHaveLength(0);
});

test("an unsettled message older than the last 20 stays shown and keeps its video evidence", async () => {
    const directory = await root();
    const key = widgetSessionKey(target);
    const blockerVideo = randomUUID();
    const settledVideo = randomUUID();
    const message = (sequence: number, state: WidgetOutgoing["state"], assetIds: string[] = []) =>
        widgetOutgoingSchema.parse({
            id: randomUUID(),
            target,
            payload: { kind: "followup", text: `message ${sequence}` },
            assetIds,
            createdAt: sequence,
            sequence,
            state,
        });
    await mutateWidgetState(directory, (state) => {
        state.selectedKey = key;
        state.preferences.showChanges = false;
        state.assets[blockerVideo] = readyVideo(blockerVideo, join(directory, "blocker-manifest.json"));
        state.assets[settledVideo] = readyVideo(settledVideo, join(directory, "settled-manifest.json"));
        state.outgoing = [
            message(1, "sent", [settledVideo]),
            message(2, "failed", [blockerVideo]),
            ...Array.from({ length: 25 }, (_, index) => message(index + 3, "queued")),
        ];
    });
    const state = await readWidgetState(directory);
    const shown = shownOutgoing(state.outgoing);
    expect(shown.map((entry) => entry.sequence)).toEqual(Array.from({ length: 26 }, (_, index) => index + 2));

    const snapshot = await widgetSnapshot({ root: directory, sources: emptySources });
    expect(snapshot.errors.some((error) => error.startsWith(`video ${blockerVideo}`))).toBe(true);
    expect(snapshot.errors.some((error) => error.startsWith(`video ${settledVideo}`))).toBe(false);
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

test("a saved state without the show-widget switch reads as off, and the preference action turns it on", async () => {
    const directory = await root();
    await writeFile(
        join(directory, "state.json"),
        SafeJSON.stringify({ version: 1, revision: 3, preferences: { placement: "top", side: "left" } })
    );
    const legacy = await readWidgetState(directory);
    expect(legacy.preferences.showWidget).toBe(false);
    expect(legacy.preferences.placement).toBe("top");
    await performWidgetAction({ root: directory, input: { action: "preferences", patch: { showWidget: true } } });
    const saved = SafeJSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    expect(saved.preferences.showWidget).toBe(true);
    expect(saved.preferences.placement).toBe("top");
    expect(saved.preferences.side).toBe("left");
    await performWidgetAction({ root: directory, input: { action: "preferences", patch: { showWidget: false } } });
    expect((await readWidgetState(directory)).preferences.showWidget).toBe(false);
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

test("failed post-copy video checks remove the unreferenced copy while successful imports stay durable", async () => {
    const directory = await root();
    const source = join(directory, "video.mp4");
    await writeFile(source, "fixture-video");
    const probe = spyOn(videos, "probeVideo").mockImplementation(async ({ input }) => ({
        path: resolve(input),
        durationUs: 1_000_000,
        width: 128,
        height: 80,
        displayWidth: 128,
        displayHeight: 80,
        rotation: 0,
        bytes: (await files.stat(input)).size,
        codec: "fixture",
    }));
    const copy = files.copyFile;
    let tamper = true;
    const copying = spyOn(files, "copyFile").mockImplementation(async (input, output, mode) => {
        await copy(input, output, mode);
        if (tamper) {
            await files.appendFile(input, "changed");
        }
    });
    try {
        await expect(importWidgetAsset({ root: directory, input: source, type: "video" })).rejects.toThrow("changed");
        expect(await readdir(join(directory, "assets"))).toEqual([]);
        expect(Object.keys((await readWidgetState(directory)).assets)).toEqual([]);
        tamper = false;
        const asset = await importWidgetAsset({ root: directory, input: source, type: "video" });
        expect(await Bun.file(asset.path).exists()).toBe(true);
        expect((await readWidgetState(directory)).assets[asset.id]).toEqual(asset);
    } finally {
        copying.mockRestore();
        probe.mockRestore();
    }
});

test("screenshot staging is removed after import success and partial capture failure", async () => {
    const directory = await root();
    let failed = false;
    const run = spyOn(commands, "boundedCommand").mockImplementation(async ({ command }) => {
        const file = command.at(-1);
        if (!file) {
            throw new Error("Fixture capture needs an output path");
        }
        await writeFile(file, failed ? Buffer.from("partial") : createCanvas(2, 2).toBuffer("image/png"));
        return { status: failed ? 1 : 0, signal: null, stdout: "", stderr: "" };
    });
    try {
        await performWidgetAction({ root: directory, input: { action: "capture", key: widgetSessionKey(target) } });
        expect((await readdir(directory)).filter((name) => name.startsWith("capture-"))).toEqual([]);
        const state = await readWidgetState(directory);
        expect(Object.keys(state.assets)).toHaveLength(1);
        expect(await Bun.file(Object.values(state.assets)[0].path).exists()).toBe(true);
        failed = true;
        await expect(
            performWidgetAction({ root: directory, input: { action: "capture", key: widgetSessionKey(target) } })
        ).rejects.toThrow("cancelled");
        expect((await readdir(directory)).filter((name) => name.startsWith("capture-"))).toEqual([]);
        expect(Object.keys((await readWidgetState(directory)).assets)).toHaveLength(1);
    } finally {
        run.mockRestore();
    }
});

test("a form answer keeps the composer text: it is serialized with the answers and restored on Edit", async () => {
    const directory = await root();
    const message = await enqueueWidgetMessage({
        root: directory,
        id: randomUUID(),
        target,
        payload: {
            kind: "form",
            id: "form-1",
            text: "picked b because the cache is per machine",
            answers: [{ itemId: "q1", selectedChoices: ["b"] }],
        },
        assetIds: [],
    });
    expect(await serializeWidgetMessage(message, await readWidgetState(directory))).toBe(
        "picked b because the cache is per machine"
    );
    await changeOutgoing({ root: directory, id: message.id, action: "edit" });
    expect((await readWidgetState(directory)).drafts[widgetSessionKey(target)]?.text).toBe(
        "picked b because the cache is per machine"
    );
});

test("unchanged video settings preserve the prepared revision and a real change invalidates it", async () => {
    const directory = await root();
    const id = randomUUID();
    const settings = { fps: 2 as const, framesPerImage: 16 as const, minimumDifferencePct: 1 };
    await mutateWidgetState(directory, (state) => {
        state.assets[id] = {
            id,
            type: "video",
            name: "video.mp4",
            path: "/fixture/video.mp4",
            sha256: "fixture",
            durationUs: 1_000_000,
            width: 128,
            height: 80,
            settings,
            revision: 3,
            confirmedRevision: 3,
            status: "ready",
            manifestPath: "/fixture/manifest.json",
        };
    });
    const unchanged = await reviseVideoAsset({ root: directory, id, settings });
    expect(unchanged).toMatchObject({
        revision: 3,
        confirmedRevision: 3,
        status: "ready",
        manifestPath: "/fixture/manifest.json",
    });
    const revised = await reviseVideoAsset({ root: directory, id, settings: { ...settings, fps: 4 } });
    expect(revised).toMatchObject({ revision: 4, status: "pending" });
    expect(revised).not.toHaveProperty("confirmedRevision");
    expect(revised).not.toHaveProperty("manifestPath");

    await mutateWidgetState(directory, (state) => {
        const asset = state.assets[id];
        if (asset?.type === "video") {
            asset.status = "failed";
            asset.error = "ffmpeg timed out";
        }
    });
    const retried = await reviseVideoAsset({ root: directory, id, settings: { ...settings, fps: 4 } });
    expect(retried).toMatchObject({ revision: 5, status: "pending" });
    expect(retried).not.toHaveProperty("error");
});

test("widget snapshots request a read-only roster and watch discovery may refresh intentionally", async () => {
    const directory = await root();
    const refreshes: (boolean | undefined)[] = [];
    const sources: WidgetSources = {
        sessions: async () => [],
        decisions: () => [],
        forms: () => [],
        answers: () => [],
        agents: async (refresh) => {
            refreshes.push(refresh);
            return { generatedAt: "", parents: [], orphans: [] };
        },
    };
    await widgetSnapshot({ root: directory, sources });
    await widgetSnapshot({ root: directory, sources, refresh: true });
    expect(refreshes).toEqual([false, true]);
});

describe("widget transport receipts", () => {
    test("a cmux send that matched no pane is a certain not-sent, not an unknown outcome", () => {
        const stdout = SafeJSON.stringify({ sent: false, matches: [] });
        expect(widgetDeliveryReceipt({ tool: "claude", result: { status: 1, stdout, stderr: "" } })).toEqual({
            success: false,
            stdout,
            stderr: "",
        });
    });

    test("a clean exit whose receipt says not sent is not a delivery", () => {
        const stdout = SafeJSON.stringify({ sent: false });
        expect(widgetDeliveryReceipt({ tool: "claude", result: { status: 0, stdout, stderr: "" } }).success).toBe(
            false
        );
    });

    test("a typed claude receipt succeeds and a failed or unreadable run stays unknown", () => {
        const sent = SafeJSON.stringify({ sent: true });
        expect(widgetDeliveryReceipt({ tool: "claude", result: { status: 0, stdout: sent, stderr: "" } }).success).toBe(
            true
        );
        const cases = [
            { tool: "claude", result: { status: 1, stdout: sent, stderr: "" } },
            { tool: "claude", result: { status: 1, stdout: "not json", stderr: "" } },
            { tool: "claude", result: { error: new Error("timed out"), status: null, stdout: "", stderr: "" } },
            { tool: "codex", result: { status: 2, stdout: "", stderr: "boom" } },
        ];
        for (const run of cases) {
            expect(() => widgetDeliveryReceipt(run)).toThrow(DeliveryUnknownError);
        }
    });
});

describe("durable capture and file shelf", () => {
    test("list is read-only and import persists a general file independently of a recipient", async () => {
        const directory = await root();
        expect((await listWidgetShelf(directory)).items).toEqual([]);
        expect(await Bun.file(join(directory, "shelf", "state.json")).exists()).toBe(false);
        const input = join(directory, "notes.txt");
        await writeFile(input, "Keep the original file");
        const result = await importShelfFile({ root: directory, input });
        expect(result.item.kind).toBe("file");
        expect(result.item.path).not.toBe(input);
        expect(await readFile(result.item.path, "utf8")).toBe("Keep the original file");
        expect((await listWidgetShelf(directory)).items).toEqual([result.item]);
        const state = await readWidgetState(directory);
        expect(state.assets).toEqual({});
        expect(state.drafts).toEqual({});
        expect(state.outgoing).toEqual([]);
    });

    test("concurrent duplicates produce one inventory item and changed bytes produce a new version", async () => {
        const directory = await root();
        const input = join(directory, "report.pdf");
        await writeFile(input, "arbitrary file bytes are not an image");
        const results = await Promise.all(Array.from({ length: 4 }, () => importShelfFile({ root: directory, input })));
        expect(new Set(results.map((result) => result.item.id)).size).toBe(1);
        expect((await listWidgetShelf(directory)).items).toHaveLength(1);
        await writeFile(input, "updated source contents");
        const updated = await importShelfFile({ root: directory, input });
        expect(updated.duplicate).toBe(false);
        expect(updated.item.id).not.toBe(results[0].item.id);
        expect(await readFile(results[0].item.path, "utf8")).toBe("arbitrary file bytes are not an image");
    });

    test("missing originals do not invalidate a managed file reference or send a message", async () => {
        const directory = await root();
        const input = join(directory, "draft.md");
        await writeFile(input, "Durable draft");
        const { item } = await importShelfFile({ root: directory, input });
        await unlink(input);
        const key = widgetSessionKey(target);
        expect(await attachShelfItem({ root: directory, id: item.id, key })).toEqual({
            added: true,
            mode: "file-reference",
        });
        expect(await attachShelfItem({ root: directory, id: item.id, key })).toEqual({
            added: false,
            mode: "file-reference",
        });
        const state = await readWidgetState(directory);
        expect(state.drafts[key].text).toContain(item.path);
        expect(state.drafts[key].assetIds).toEqual([]);
        expect(state.outgoing).toEqual([]);
        expect(await readFile(item.path, "utf8")).toBe("Durable draft");
    });

    test("removing from the shelf never deletes an original or an already referenced managed file", async () => {
        const directory = await root();
        const input = join(directory, "source.txt");
        await writeFile(input, "Preserve both");
        const { item } = await importShelfFile({ root: directory, input });
        await attachShelfItem({ root: directory, id: item.id, key: widgetSessionKey(target) });
        await removeShelfItem({ root: directory, id: item.id });
        expect((await listWidgetShelf(directory)).items).toEqual([]);
        expect(await readFile(input, "utf8")).toBe("Preserve both");
        expect(await readFile(item.path, "utf8")).toBe("Preserve both");
    });

    test("import failures and pre-cancellation leave the inventory unchanged", async () => {
        const directory = await root();
        await expect(importShelfFile({ root: directory, input: directory })).rejects.toThrow("regular file");
        await expect(importShelfFile({ root: directory, input: join(directory, "missing.txt") })).rejects.toThrow();
        const controller = new AbortController();
        controller.abort();
        await expect(
            importShelfFile({ root: directory, input: directory, signal: controller.signal })
        ).rejects.toThrow();
        expect((await listWidgetShelf(directory)).items).toEqual([]);
    });

    test("an import withdrawn while it waits for the shelf lock commits nothing", async () => {
        const directory = await root();
        const input = join(directory, "notes.txt");
        await writeFile(input, "Withdrawn while another writer held the shelf");
        const controller = new AbortController();
        const realLock = fileLock.withFileLock;
        // The caller withdraws while another shelf writer holds the lock.
        const waiting = spyOn(fileLock, "withFileLock").mockImplementation((path, fn, timeout) => {
            if (path.endsWith(join("shelf", "state.lock"))) {
                controller.abort();
            }

            return realLock(path, fn, timeout);
        });
        try {
            await expect(importShelfFile({ root: directory, input, signal: controller.signal })).rejects.toThrow();
            expect((await listWidgetShelf(directory)).items).toEqual([]);
            expect(
                await readdir(join(directory, "shelf", "files", (await readdir(join(directory, "shelf", "files")))[0]))
            ).toEqual([]);
            const imported = await importShelfFile({ root: directory, input });
            expect((await listWidgetShelf(directory)).items).toEqual([imported.item]);
        } finally {
            waiting.mockRestore();
        }
    });

    test("a cancelled capture can be followed by a capture staged without a recipient", async () => {
        const directory = await root();
        await expect(
            captureShelfImage({
                root: directory,
                capture: async () => {
                    throw new Error("Cancelled fixture");
                },
            })
        ).rejects.toThrow("Cancelled fixture");
        expect((await listWidgetShelf(directory)).items).toEqual([]);
        const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9h8AAAAASUVORK5CYII=",
            "base64"
        );
        const item = await captureShelfImage({
            root: directory,
            capture: async ({ output }) => {
                await writeFile(output, png);
                return { status: 0 };
            },
        });
        if ("cancelled" in item) {
            throw new Error("Expected the image fixture to be captured");
        }

        expect(item.kind).toBe("capture");
        expect((await readWidgetState(directory)).drafts).toEqual({});
        const key = widgetSessionKey(target);
        expect(await attachShelfItem({ root: directory, id: item.id, key })).toEqual({ added: true, mode: "image" });
        const state = await readWidgetState(directory);
        expect(state.drafts[key].assetIds).toEqual([item.assetId!]);
        expect(state.outgoing).toEqual([]);
    });

    test("a missing managed file produces a truthful failure instead of a broken draft", async () => {
        const directory = await root();
        const input = join(directory, "available.txt");
        await writeFile(input, "temporary fixture");
        const { item } = await importShelfFile({ root: directory, input });
        await unlink(item.path);
        await expect(attachShelfItem({ root: directory, id: item.id, key: widgetSessionKey(target) })).rejects.toThrow(
            "unavailable"
        );
        expect((await readWidgetState(directory)).drafts).toEqual({});
    });
});

test("receipt context reads only its stored source and exact provider/session", async () => {
    const directory = await root();
    const project = join(directory, "projects", "fixture-project");
    await mkdir(project, { recursive: true });
    await writeFile(
        join(project, "fixture-session.jsonl"),
        `${SafeJSON.stringify({
            type: "user",
            uuid: "native-message",
            timestamp: "2026-01-01T10:00:00Z",
            message: { role: "user", content: "stored native context" },
        })}\n`
    );
    const receipt: ReturnType<WidgetSources["answers"]>[number] = {
        id: "fixture-answer",
        ts: Date.parse("2026-01-01T10:00:00Z"),
        sessionId: "fixture-session",
        sessionTitle: "Fixture",
        project: "Fixture project",
        repoRoot: "/fixture/project",
        cwd: "/fixture/project",
        branch: "feat/example",
        commitSha: "abc123",
        commitMessage: null,
        agent: "claude-code",
        isWorktree: true,
        worktreePath: "/fixture/worktree",
        aiAgent: null,
        agentLabel: "Worker",
        tag: "question",
        question: "Question",
        answerMd: "Unrelated large answer body",
        refs: [],
        source: "mcp",
        turnUuid: null,
        supersededBy: null,
        readAt: null,
        transcriptAnchor: {
            kind: "native" as const,
            provider: "claude" as const,
            sessionId: "fixture-session",
            receivedAt: Date.parse("2026-01-01T10:00:00Z"),
            messageId: "native-message",
        },
    };
    const sources: Pick<WidgetSources, "answers" | "decisions" | "forms"> = {
        answers: (session) => {
            expect(session).toBe("fixture-session");
            return [receipt];
        },
        decisions: () => {
            throw new Error("Must not scan other receipt stores");
        },
        forms: () => {
            throw new Error("Must not scan other receipt stores");
        },
    };
    const key = widgetSessionKey({
        ...target,
        provider: "claude",
        sessionId: "fixture-session",
        sourceHome: directory,
    });
    const context = await readWidgetReceiptContext({ key, id: "answer:fixture-answer", sources });
    expect(context.error).toBeUndefined();
    expect(context.sourceContext).toMatchObject({
        agentLabel: "Worker",
        branch: "feat/example",
        worktreePath: "/fixture/worktree",
    });
    expect(context.sourceContext).not.toHaveProperty("answerMd");
    expect(context.transcript?.status).toBe("native");
    expect(context.transcript?.around[0]?.text).toBe("stored native context");
    const foreignKey = widgetSessionKey({
        ...target,
        provider: "codex",
        sessionId: "fixture-session",
        sourceHome: directory,
    });
    await expect(readWidgetReceiptContext({ key: foreignKey, id: "answer:fixture-answer", sources })).rejects.toThrow(
        "provider/session"
    );
    await expect(readWidgetReceiptContext({ key, id: "answer:missing", sources })).rejects.toThrow("not found");
    // An agent the Widget has no session kind for (copilot) is the "unknown" session the snapshot showed, not a mismatch.
    const unknownKey = widgetSessionKey({
        ...target,
        provider: "unknown",
        sessionId: "fixture-session",
        sourceHome: directory,
    });
    const cursorSources = {
        ...sources,
        answers: () => [
            {
                ...receipt,
                agent: "copilot" as const,
                transcriptAnchor: { kind: "unanchored" as const, receivedAt: receipt.ts },
            },
        ],
    };
    expect(
        (await readWidgetReceiptContext({ key: unknownKey, id: "answer:fixture-answer", sources: cursorSources }))
            .sourceContext
    ).toMatchObject({ agent: "copilot" });
    await expect(readWidgetReceiptContext({ key, id: "answer:fixture-answer", before: 20, sources })).rejects.toThrow(
        "between 0 and 10"
    );
});

test("receipt inspection reads an old stored answer without creating tables, ingesting or applying a history cap", async () => {
    const directory = await root();
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: directory }, async () => {
        const dbPath = toolDataDir("question", "qa.db");
        await mkdir(toolDataDir("question"), { recursive: true });
        const db = new Database(dbPath);
        db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, ts INTEGER, session_id TEXT, agent TEXT, refs_json TEXT)");
        const insert = db.query("INSERT INTO entries VALUES (?, ?, 'fixture-session', 'unknown', '[]')");
        for (let index = 0; index < 100; index++) {
            insert.run(`fixture-${index}`, index + 1);
        }
        db.close();
        const before = await readFile(dbPath);
        const key = widgetSessionKey({ ...target, provider: "unknown", sessionId: "fixture-session" });
        const context = await readWidgetReceiptContext({ key, id: "answer:fixture-0" });
        expect(context.id).toBe("answer:fixture-0");
        expect(context.sourceContext?.sessionId).toBe("fixture-session");
        expect(context.transcriptAnchor.kind).toBe("unanchored");
        expect(await readFile(dbPath)).toEqual(before);
        const inspected = new Database(dbPath, { readonly: true });
        try {
            const tables = inspected.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
            expect(tables).toEqual([{ name: "entries" }]);
        } finally {
            inspected.close();
        }
    });
});

test("explicit shelf images deduplicate while general image files remain file references", async () => {
    const directory = await root();
    const input = join(directory, "clipboard.png");
    await writeFile(
        input,
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9h8AAAAASUVORK5CYII=",
            "base64"
        )
    );
    const first = await stageShelfImage({ root: directory, input });
    const second = await stageShelfImage({ root: directory, input });
    expect(second.id).toBe(first.id);
    const general = await importShelfFile({ root: directory, input });
    expect(general.item.kind).toBe("file");
    expect(general.item.assetId).toBeUndefined();
    expect((await listWidgetShelf(directory)).items).toHaveLength(2);
    expect((await readWidgetState(directory)).drafts).toEqual({});
    await mutateWidgetState(directory, (state) => {
        delete state.assets[first.assetId!];
    });
    const recovered = await stageShelfImage({ root: directory, input });
    expect(recovered.id).not.toBe(first.id);
    expect((await listWidgetShelf(directory)).items).toHaveLength(2);
    expect(await attachShelfItem({ root: directory, id: recovered.id, key: widgetSessionKey(target) })).toEqual({
        added: true,
        mode: "image",
    });
    const bad = join(directory, "not-an-image.png");
    await writeFile(bad, "not image bytes");
    await expect(stageShelfImage({ root: directory, input: bad })).rejects.toThrow();
    expect((await listWidgetShelf(directory)).items).toHaveLength(2);
});

test("cancel after producing a capture cleans temporary bytes and allows restart", async () => {
    const directory = await root();
    const controller = new AbortController();
    let temporary = "";
    await expect(
        captureShelfImage({
            root: directory,
            signal: controller.signal,
            capture: async ({ output }) => {
                temporary = output;
                await writeFile(output, "partial capture");
                controller.abort();
                return { status: 0 };
            },
        })
    ).rejects.toThrow();
    expect(await Bun.file(temporary).exists()).toBe(false);
    expect((await listWidgetShelf(directory)).items).toEqual([]);
    expect((await readWidgetState(directory)).assets).toEqual({});
});

test("orphan forms retain stored providers and their receipt context accepts the snapshot identity", async () => {
    const directory = await root();
    const forms: ReturnType<WidgetSources["forms"]> = [
        {
            id: "codex-form",
            sessionHint: "orphan-codex",
            status: "pending",
            createdAt: 1,
            projectPath: "/fixture",
            cwd: "/fixture",
            items: [],
            poster: {
                agent: "codex",
                sessionId: "orphan-codex",
                isInAgent: true,
                aiAgent: null,
                sessionTitle: null,
                project: "Fixture",
                repoRoot: "/fixture",
                cwd: "/fixture",
                isWorktree: false,
                worktreePath: null,
                branch: null,
                commitSha: null,
                commitMessage: null,
            },
            transcriptAnchor: { kind: "unanchored", receivedAt: 1 },
        },
        {
            id: "grok-form",
            sessionHint: "orphan-grok",
            status: "pending",
            createdAt: 2,
            projectPath: "/fixture",
            cwd: "/fixture",
            items: [],
            transcriptAnchor: { kind: "receipt-time", provider: "grok", sessionId: "orphan-grok", receivedAt: 2 },
        },
        {
            id: "unknown-form",
            sessionHint: "orphan-unknown",
            status: "pending",
            createdAt: 3,
            projectPath: "/fixture",
            cwd: "/fixture",
            items: [],
        },
    ];
    const sources: WidgetSources = {
        sessions: async () => [],
        decisions: () => [],
        answers: () => [],
        agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
        forms: (session) => forms.filter((form) => !session || form.sessionHint === session),
    };
    const snapshot = await widgetSnapshot({ root: directory, sources });
    expect(snapshot.sessions.map((session) => session.target.provider).sort()).toEqual(["codex", "grok", "unknown"]);
    const card = snapshot.cards.find((entry) => entry.sourceId === "codex-form");
    expect(card).toBeDefined();
    const context = await readWidgetReceiptContext({ key: card!.sessionKey, id: card!.id, sources });
    expect(context.transcriptAnchor.kind).toBe("unanchored");
    expect(context.sourceContext?.agent).toBe("codex");
    const selectedKey = widgetSessionKey({ ...target, provider: "grok", sessionId: "orphan-grok", sourceHome: "" });
    const selected = await widgetSnapshot({
        root: directory,
        selectedKey,
        sources: { ...sources, forms: (session) => (session ? [forms[1]] : []) },
    });
    expect(selected.sessions[0]?.target.provider).toBe("grok");
    expect(selected.cards[0]?.sessionKey).toBe(selectedKey);
});

test("shelf attachment descriptors inspect metadata and draft without creating or changing durable state", async () => {
    const directory = await root();
    const input = join(directory, "notes.txt");
    await writeFile(input, "Shelf descriptor fixture");
    const { item } = await importShelfFile({ root: directory, input });
    const shelfBefore = await readFile(join(directory, "shelf", "state.json"));
    const stateFile = Bun.file(join(directory, "state.json"));
    expect(await stateFile.exists()).toBe(false);
    const descriptor = await readShelfAttachment({ root: directory, id: item.id, key: "chosen" });
    expect(descriptor).toEqual({
        mode: "file-reference",
        reference: `File: notes.txt\nLocal path: ${item.path}`,
        draft: { text: "", assetIds: [] },
    });
    expect(
        await performWidgetAction({
            root: directory,
            input: { action: "shelf-attachment", id: item.id, key: "chosen" },
        })
    ).toEqual(descriptor);
    expect(await stateFile.exists()).toBe(false);
    expect(await readFile(join(directory, "shelf", "state.json"))).toEqual(shelfBefore);
    await mutateWidgetState(directory, (state) => {
        state.drafts.chosen = { text: "Existing draft", assetIds: [] };
    });
    const before = await stateFile.bytes();
    expect((await readShelfAttachment({ root: directory, id: item.id, key: "chosen" })).draft.text).toBe(
        "Existing draft"
    );
    expect(await stateFile.bytes()).toEqual(before);
    const absent = join(directory, "not-created");
    await expect(readShelfAttachment({ root: absent, id: "missing", key: "chosen" })).rejects.toThrow("unavailable");
    expect(await Bun.file(join(absent, "state.json")).exists()).toBe(false);
});

test("native capture exit classification keeps cancellation separate from permission and process failures", async () => {
    const directory = await root();
    expect(await captureShelfImage({ root: directory, capture: async () => ({ status: 0, stderr: "" }) })).toEqual({
        cancelled: true,
    });
    expect((await listWidgetShelf(directory)).items).toEqual([]);
    await expect(
        captureShelfImage({
            root: directory,
            capture: async () => ({ status: 1, stderr: "could not create image from window\n" }),
        })
    ).rejects.toThrow("Screenshot capture failed: could not create image from window");
    await expect(
        captureShelfImage({
            root: directory,
            capture: async () => ({ status: 0, error: new Error("Capture timed out") }),
        })
    ).rejects.toThrow("Capture timed out");
    expect((await listWidgetShelf(directory)).items).toEqual([]);
    expect((await readWidgetState(directory)).drafts).toEqual({});
});
