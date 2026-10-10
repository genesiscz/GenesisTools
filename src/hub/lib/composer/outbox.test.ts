import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as files from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DeliveryUnknownError } from "@app/question/lib/decisions/deliver";
import { livePaneTargets } from "@app/question/lib/decisions/deliver.fixtures";
import { decisionFiles, deliverDecisions } from "@app/question/lib/decisions/read";
import { type DecisionRecord, postDecisions, readDecisions } from "@app/question/lib/decisions/store";
import { sendInboxMessage } from "@app/question/lib/message";
import { postAskForm } from "@app/question/lib/pending/ask";
import { MAX_ANSWER_IMAGE_BYTES } from "@app/question/lib/pending/form";
import { getForm, listFormsSnapshot, openPendingStore } from "@app/question/lib/pending/store";
import { openReadModel, readQuestionSnapshot } from "@app/question/lib/read-model";
import * as queueModule from "@genesiscz/utils/agent-sessions/message-queue";
import {
    acknowledgeSessionMessage,
    enqueueSessionMessage,
    listSessionMessages,
    offerSessionMessage,
} from "@genesiscz/utils/agent-sessions/message-queue";
import * as transcripts from "@genesiscz/utils/ai/transcripts";
import { withTimeout } from "@genesiscz/utils/async";
import { env } from "@genesiscz/utils/env";
import { encodeRgbaToPng } from "@genesiscz/utils/image/raster";
import { SafeJSON } from "@genesiscz/utils/json";
import * as commands from "@genesiscz/utils/process/bounded-command";
import * as fileLock from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import * as videos from "@genesiscz/utils/video/probe";
import { createCanvas } from "@napi-rs/canvas";
import { z } from "zod";
import type { AgentNode } from "../agents/types";
import { performWidgetAction } from "../widget/actions";
import { liftCardImages } from "../widget/card-images";
import { readWidgetReceiptContext } from "../widget/context";
import { createWidgetHandoff } from "../widget/handoff";
import { readWidgetRosterCache, writeWidgetRosterCache } from "../widget/roster-cache";
import { widgetRosterChange } from "../widget/roster-index";
import { WidgetRosterReader, type WidgetRosterReply } from "../widget/roster-reader";
import {
    classifyScreenshot,
    parseUiSoundSetting,
    SCREEN_RECORDING_DENIED,
    ScreenRecordingDeniedError,
    type ScreenshotRunner,
} from "../widget/screenshot";
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
    claudeAssistantText,
    discoverWidgetCatalog,
    inboxWindowCounts,
    lastClaudeAssistantText,
    readWidgetChanges,
    readWidgetDecisionEvents,
    realWidgetSources,
    type WidgetInboxWindow,
    type WidgetSources,
    widgetForms,
    widgetResultNode,
    widgetSnapshot,
} from "../widget/snapshot";
import { MAX_WIDGET_STATE_BYTES, mutateWidgetState, readWidgetState } from "../widget/storage";
import {
    parseWidgetSessionKey,
    shownOutgoing,
    type WidgetAsset,
    type WidgetOutgoing,
    type WidgetTarget,
    widgetOutgoingSchema,
    widgetPreferencesSchema,
    widgetSessionKey,
} from "../widget/types";
import {
    discardVoiceNote,
    editVoiceNote,
    listVoiceNotes,
    recordVoiceNote,
    transcribeVoiceNote,
} from "../widget/voice-notes";
import { watchWidget } from "../widget/watch";
import { importWidgetAsset, reviseVideoAsset } from "./assets";
import { widgetDeliveryReceipt, widgetDispatcher } from "./dispatch";
import { processWidgetOutbox } from "./engine";
import { changeOutgoing, enqueueWidgetMessage, messageReadiness, recoverWidgetOutbox } from "./outbox";
import { serializeWidgetMedia, serializeWidgetMessage } from "./serialize";

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

describe("video dispatch media bounds", () => {
    test("cancelling queued preparation aborts its actual worker job and permits a fresh queued attempt", async () => {
        const directory = await root();
        const id = randomUUID();
        await mutateWidgetState(directory, (state) => {
            state.assets[id] = {
                id,
                type: "video",
                name: "source.mp4",
                path: "/fixture/source.mp4",
                sha256: "fixture",
                width: 32,
                height: 32,
                durationUs: 1_000_000,
                settings: { fps: 2, framesPerImage: 4, minimumDifferencePct: 0 },
                revision: 1,
                status: "pending",
            };
        });
        const message = await enqueue(directory, "Preparing video", target, [id]);
        let began!: () => void;
        let aborted!: () => void;
        let restarted!: () => void;
        const started = new Promise<void>((resolve) => {
            began = resolve;
        });
        const stopped = new Promise<void>((resolve) => {
            aborted = resolve;
        });
        const again = new Promise<void>((resolve) => {
            restarted = resolve;
        });
        const controller = new AbortController();
        let starts = 0;
        let sends = 0;
        const worker = watchWidget({
            root: directory,
            signal: controller.signal,
            emit: () => {},
            dependencies: {
                inboxPaths: {
                    answerLog: join(directory, "question/log"),
                    database: join(directory, "question/qa.db"),
                    decisions: join(directory, "question/decisions.jsonl"),
                },
                snapshot: async () => ({
                    version: 1,
                    state: await readWidgetState(directory),
                    activity: [],
                    sessions: [],
                    cards: [],
                    manifests: {},
                    changes: null,
                    errors: [],
                    selectedKey: null,
                }),
                dispatcher: {
                    validate: async () => {},
                    dispatch: async () => {
                        sends++;
                        return { delivered: true, channel: "fixture" };
                    },
                },
                prepare: async ({ signal }) => {
                    starts++;
                    if (starts === 1) {
                        began();
                    } else {
                        restarted();
                    }
                    await new Promise<void>((resolve) => {
                        if (signal?.aborted) {
                            resolve();
                        } else {
                            signal?.addEventListener("abort", () => resolve(), { once: true });
                        }
                    });
                    if (starts === 1) {
                        aborted();
                    }
                    signal?.throwIfAborted();
                },
            },
        });
        try {
            await withTimeout(started, 3000);
            await changeOutgoing({ root: directory, id: message.id, action: "cancel" });
            await withTimeout(stopped, 3000);
            expect((await readWidgetState(directory)).outgoing[0]?.state).toBe("cancelled");
            expect(sends).toBe(0);
            await enqueue(directory, "Fresh attempt", target, [id]);
            await withTimeout(again, 3000);
            expect(starts).toBe(2);
            expect(sends).toBe(0);
        } finally {
            controller.abort();
            await withTimeout(worker, 3000);
        }
    });
    test("oversized video sheets cannot cross dispatch, while a small manifest still sends", async () => {
        const directory = await root();
        const id = randomUUID();
        const manifestPath = join(directory, "manifest.json");
        const source = {
            path: "/fixture/source.mp4",
            durationUs: 600_000_000,
            width: 32,
            height: 32,
            displayWidth: 32,
            displayHeight: 32,
            rotation: 0,
            bytes: 100,
            codec: "fixture",
            sha256: "fixture",
        };
        const settings = { fps: 4 as const, framesPerImage: 1 as const, minimumDifferencePct: 0 };
        const sheets = Array.from({ length: 2400 }, (_, index) => ({
            path: `/fixture/${"long-local-directory-".repeat(8)}/sheet-${index}.png`,
            frameIds: [String(index)],
            firstUs: index * 250_000,
            lastUs: index * 250_000,
            columns: 1,
            rows: 1,
        }));
        const manifest = {
            version: 1,
            id: randomUUID(),
            source,
            settings,
            createdAt: new Date().toISOString(),
            manifestPath,
            frames: sheets.map((sheet, index) => ({
                id: String(index),
                requestedUs: sheet.firstUs,
                actualUs: sheet.firstUs,
                sourceIndex: index,
                path: `/fixture/frame-${index}.png`,
                kept: true,
                differencePct: index === 0 ? null : 100,
                comparedToId: index === 0 ? null : String(index - 1),
            })),
            sheets,
            counts: { candidates: 2400, kept: 2400, skipped: 0, images: 2400, lastImageFrames: 1 },
        };
        await Bun.write(manifestPath, SafeJSON.stringify(manifest));
        await mutateWidgetState(directory, (state) => {
            state.assets[id] = {
                id,
                type: "video",
                name: "source.mp4",
                path: source.path,
                sha256: source.sha256,
                width: 32,
                height: 32,
                durationUs: source.durationUs,
                settings,
                revision: 1,
                status: "ready",
                manifestPath,
            };
        });
        const message = await enqueue(directory, "Inspect video", target, [id]);
        let calls = 0;
        const dispatcher = {
            validate: async () => {},
            dispatch: async () => {
                calls++;
                return { delivered: true, channel: "fixture" };
            },
        };
        await processWidgetOutbox({ root: directory, dispatcher });
        expect(calls).toBe(0);
        expect((await readWidgetState(directory)).outgoing[0]?.state).toBe("failed");
        expect((await readWidgetState(directory)).outgoing[0]?.error).toContain("media context");
        await Bun.write(
            manifestPath,
            SafeJSON.stringify({
                ...manifest,
                sheets: sheets.slice(0, 1),
                frames: manifest.frames.slice(0, 1),
                counts: { candidates: 1, kept: 1, skipped: 0, images: 1, lastImageFrames: 1 },
            })
        );
        await changeOutgoing({ root: directory, id: message.id, action: "retry" });
        await processWidgetOutbox({ root: directory, dispatcher });
        expect(calls).toBe(1);
        expect((await readWidgetState(directory)).outgoing[0]?.state).toBe("sent");
        const asset = (await readWidgetState(directory)).assets[id];
        if (asset.type !== "video") {
            throw new Error("Expected video fixture");
        }

        const selected = { ...settings, startUs: 2_000_000, endUs: 4_000_000 };
        await Bun.write(
            manifestPath,
            SafeJSON.stringify({
                ...manifest,
                settings: selected,
                sheets: sheets.slice(0, 1),
                frames: manifest.frames.slice(0, 1),
            })
        );
        const context = await serializeWidgetMedia([{ ...asset, settings: selected }]);
        expect(context).toContain('"durationSeconds": 600');
        expect(context).toContain('"selectedRangeSeconds": {\n    "start": 2,\n    "end": 4\n  }');
        expect(context).toContain("Timestamps refer to the original video");
    });
});

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
                    return { success: true, stdout: '{"queued":false,"turnId":"fixture-turn"}', stderr: "" };
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

    test("a media-only reply keeps the original session and card title in one literal message", async () => {
        const directory = await root();
        const files = { file: join(directory, "decisions.jsonl"), events: join(directory, "events.jsonl") };
        const destination = { ...target, provider: "claude" as const, sessionId: "original-session", sourceHome: "" };
        const [, row] = await postDecisions(
            files.file,
            files.events,
            {
                sessionId: destination.sessionId,
                provider: destination.provider,
                decisions: [
                    { prompt: "Earlier item?", options: ["yes"] },
                    { title: "Chat DECISION 4: next token kinds", prompt: "Where do they go?", options: ["yes"] },
                ],
            },
            { env: {} }
        );
        const calls: string[][] = [];
        const dispatcher = widgetDispatcher({
            files,
            deliver: {
                findTargets: livePaneTargets,
                runTool: async (args) => {
                    calls.push(args);
                    return { success: true, stdout: '{"sent":true}', stderr: "" };
                },
            },
        });
        const message = widgetOutgoingSchema.parse({
            id: randomUUID(),
            target: destination,
            assetIds: [],
            sequence: 1,
            createdAt: Date.now(),
            state: "queued",
            payload: { kind: "decision", id: row.id, number: row.number, expectedRevision: 1, text: "" },
        });
        await expect(
            dispatcher.validate({ ...message, target: { ...destination, sessionId: "different-session" } }, [])
        ).rejects.toThrow("belongs to another session");
        expect(calls).toHaveLength(0);
        await dispatcher.validate(message, []);
        const media = [
            '<fromVideo>\n{\n  "path": "/fixture/video.mov",\n  "frames": ["first", "second"]\n}\n</fromVideo>',
            '<fromImage>\n{\n  "path": "/fixture/c96d5e67-first.png"\n}\n</fromImage>',
            '<fromImage>\n{\n  "path": "/fixture/second.png"\n}\n</fromImage>',
        ].join("\n\n");
        expect(await dispatcher.dispatch(message, media, [])).toMatchObject({ delivered: true, channel: "cmux" });
        expect(calls).toEqual([
            [
                "claude",
                "cmux",
                "send",
                "original-session",
                `Reply to: Chat DECISION 4: next token kinds\nLedger decision 2 (${row.id})\n${media}`,
                "--json",
                "--paste",
                "--exact-session",
            ],
        ]);
        expect(readDecisions(files.file).map((entry) => [entry.sessionId, entry.number, entry.state])).toEqual([
            ["original-session", 1, "open"],
            ["original-session", 2, "sent"],
        ]);
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
                    const receipt = accept
                        ? { queued: false, turnId: "fixture-turn" }
                        : { kind: "rejected", backend: "codex", name: "fixture-worker", error: "worker gone" };
                    return { success: accept, stdout: SafeJSON.stringify(receipt), stderr: "" };
                },
            },
        });
        // No source home: a refusal has no durable session queue to fall back to, so the answer waits for a Retry.
        const message = widgetOutgoingSchema.parse({
            id: randomUUID(),
            target: { ...target, sourceHome: "" },
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

    test("a missing route saves one canonical queued answer without claiming success or replaying through the prompt hook", async () => {
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
                queueRoot: join(directory, "session-queue"),
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
        expect(readDecisions(files.file)[0]).toMatchObject({
            id: row.id,
            state: "answered",
            delivery: { route: "queued", queueId: expect.any(String) },
        });
        expect(() =>
            deliverDecisions(readDecisions(files.file), () => {
                throw new Error("must not duplicate queue delivery");
            })
        ).toThrow("nothing to send");
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

    test("a widget image over the answer limit stays context and never fails a complete answer", async () => {
        const directory = await root();
        const db = openPendingStore(join(directory, "questions.db"));
        const ask = { db, eventBase: directory, logBase: directory, notify: false, env: {}, ambient: false };
        try {
            const post = (items: Parameters<typeof postAskForm>[0]["items"]) =>
                postAskForm({ projectPath: "/fixture/project", sessionHint: target.sessionId, items }, ask);
            const imagePath = join(directory, "large.png");
            await writeFile(imagePath, Buffer.alloc(MAX_ANSWER_IMAGE_BYTES + 1));
            const large: WidgetAsset = {
                id: randomUUID(),
                type: "image",
                name: "large.png",
                path: imagePath,
                sha256: "fixture-large",
                mimeType: "image/png",
                width: 4000,
                height: 4000,
                bytes: MAX_ANSWER_IMAGE_BYTES + 1,
            };
            const formMessage = (id: string, answers: unknown[]) =>
                widgetOutgoingSchema.parse({
                    id: randomUUID(),
                    target,
                    assetIds: [large.id],
                    sequence: 1,
                    createdAt: Date.now(),
                    state: "queued",
                    payload: { kind: "form", id, answers },
                });
            const dispatcher = widgetDispatcher({ ask });

            const choice = await post([
                { id: "pick", promptMarkdown: "Which?", choices: [{ id: "a", label: "A" }], allowImagePaste: true },
            ]);
            const answered = formMessage(choice.id, [{ itemId: "pick", selectedChoices: ["a"] }]);
            await dispatcher.validate(answered, [large]);
            expect((await dispatcher.dispatch(answered, "<fromImage>large</fromImage>", [large])).delivered).toBe(true);
            const recorded = getForm(db, choice.id)?.answers?.pick;
            expect(recorded?.images ?? []).toEqual([]);
            expect(recorded?.mediaContext).toContain("large");

            const imageOnly = await post([
                { id: "shot", promptMarkdown: "Show it", allowFreeText: false, allowImagePaste: true },
            ]);
            await expect(dispatcher.validate(formMessage(imageOnly.id, [{ itemId: "shot" }]), [large])).rejects.toThrow(
                "attach a smaller image or answer in text"
            );
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
    const captures: string[][] = [];
    const run = spyOn(commands, "boundedCommand").mockImplementation(async ({ command }) => {
        if (command[0] === "/usr/bin/defaults") {
            // The sound key is absent until the user changes it once.
            return { status: 1, signal: null, stdout: "", stderr: "" };
        }

        captures.push(command);
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
        ).rejects.toThrow("Screenshot capture failed: exit 1");
        expect((await readdir(directory)).filter((name) => name.startsWith("capture-"))).toEqual([]);
        expect(Object.keys((await readWidgetState(directory)).assets)).toHaveLength(1);
        // Sound effects are on by default, so neither capture passes `-x`.
        expect(captures.map((command) => command.includes("-x"))).toEqual([false, false]);
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
    const clipped = await reviseVideoAsset({
        root: directory,
        id,
        settings: { ...settings, fps: 4, startUs: 250_000, endUs: 750_000 },
    });
    expect(clipped).toMatchObject({ revision: 5, status: "pending", settings: { startUs: 250_000, endUs: 750_000 } });
    await expect(
        reviseVideoAsset({ root: directory, id, settings: { ...settings, endUs: 1_000_001 } })
    ).rejects.toThrow();
    expect((await readWidgetState(directory)).assets[id]).toMatchObject({ revision: 5 });
    const restored = await reviseVideoAsset({ root: directory, id, settings });
    expect(restored).toMatchObject({ revision: 6, settings });
    await mutateWidgetState(directory, (state) => {
        const asset = state.assets[id];
        if (asset?.type === "video") {
            asset.status = "failed";
            asset.error = "synthetic preparation failure";
        }
    });
    const retried = await reviseVideoAsset({ root: directory, id, settings });
    expect(retried).toMatchObject({ revision: 7, status: "pending", settings });
    expect(retried).not.toHaveProperty("error");
});

test("media of a message already saved in a session queue cannot change under it", async () => {
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
            revision: 1,
            status: "pending",
        };
    });
    const message = await enqueue(directory, "Queued with media", target, [id]);
    await mutateWidgetState(directory, (state) => {
        const current = state.outgoing.find((entry) => entry.id === message.id)!;
        current.state = "waiting-route";
        current.receipt = { channel: "session-queue", delivered: false, entryId: "fixture-entry", at: 1 };
    });
    await expect(reviseVideoAsset({ root: directory, id, settings: { ...settings, fps: 4 } })).rejects.toThrow(
        "immutable"
    );
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
    expect(await discoverWidgetCatalog(sources)).toEqual({ sessions: 0, agents: 0 });
    expect(refreshes).toEqual([false, true, true]);
});

describe("widget transport receipts", () => {
    test("a cmux send that matched no pane is a certain not-sent, not an unknown outcome", () => {
        const stdout = SafeJSON.stringify({ sent: false, matches: [] });
        expect(
            widgetDeliveryReceipt({ args: ["claude", "cmux", "send"], result: { status: 1, stdout, stderr: "" } })
        ).toEqual({
            success: false,
            stdout,
            stderr: "",
        });
    });

    test("a clean exit whose receipt says not sent is not a delivery", () => {
        const stdout = SafeJSON.stringify({ sent: false });
        expect(
            widgetDeliveryReceipt({ args: ["claude", "cmux", "send"], result: { status: 0, stdout, stderr: "" } })
                .success
        ).toBe(false);
    });

    test("a typed claude receipt succeeds and a failed or unreadable run stays unknown", () => {
        const sent = SafeJSON.stringify({ sent: true });
        expect(
            widgetDeliveryReceipt({ args: ["claude", "cmux", "send"], result: { status: 0, stdout: sent, stderr: "" } })
                .success
        ).toBe(true);
        const cmux = ["claude", "cmux", "send"];
        const cases = [
            { args: cmux, result: { status: 1, stdout: sent, stderr: "" } },
            { args: cmux, result: { status: 1, stdout: "not json", stderr: "" } },
            { args: cmux, result: { error: new Error("timed out"), status: null, stdout: "", stderr: "" } },
            { args: ["claude", "resume"], result: { status: 2, stdout: "", stderr: "boom" } },
        ];
        for (const run of cases) {
            expect(() => widgetDeliveryReceipt(run)).toThrow(DeliveryUnknownError);
        }
    });

    test("codex and native turns report a refusal through their exit status, not as an unknown outcome", () => {
        for (const args of [
            ["codex", "steer"],
            ["claude", "worker", "send"],
            ["grok", "steer"],
        ]) {
            const result = { status: 1, stdout: '{"rejected":true}', stderr: "" };
            expect(widgetDeliveryReceipt({ args, result }).success).toBe(false);
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

test("a staged capture withdrawn after its asset import or while waiting for the shelf leaves no asset behind", async () => {
    for (const lock of ["state.lock", join("shelf", "state.lock")]) {
        const directory = await root();
        const input = join(directory, "capture.png");
        await writeFile(
            input,
            Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9h8AAAAASUVORK5CYII=",
                "base64"
            )
        );
        const controller = new AbortController();
        const realLock = fileLock.withFileLock;
        const waiting = spyOn(fileLock, "withFileLock").mockImplementation((path, fn, timeout) => {
            if (path === join(directory, lock)) {
                controller.abort();
            }

            return realLock(path, fn, timeout);
        });
        try {
            await expect(stageShelfImage({ root: directory, input, signal: controller.signal })).rejects.toThrow();
        } finally {
            waiting.mockRestore();
        }

        expect((await readWidgetState(directory)).assets).toEqual({});
        expect(await readdir(join(directory, "assets"))).toEqual([]);
        expect((await listWidgetShelf(directory)).items).toEqual([]);
    }
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

describe("widget inbox notifications", () => {
    // These fixtures date their items near the epoch. With the clock there, none of them is past the stale window;
    // the age-out has its own test below.
    const FIXTURE_CLOCK = 0;
    test("global unread counts exceed selected-card limits without durable snapshot writes", async () => {
        const directory = await root();
        await env.testing.withOverrides(
            { GENESIS_TOOLS_HOME: directory, QUESTION_LOG_BASE: join(directory, "log") },
            async () => {
                const path = toolDataDir("question", "qa.db");
                const db = openReadModel(path);
                const insert = db.query(
                    "INSERT INTO entries (id,ts,session_id,session_title,agent,question,answer_md,refs_json,project,cwd,source,tag) VALUES (?,? ,?,'Fixture','codex','Question','Answer','[]','Fixture','/fixture','mcp','question')"
                );
                for (let index = 0; index < 151; index++) {
                    insert.run(`inbox-${index}`, index + 1, index === 150 ? "fixture-b" : "fixture-a");
                }
                db.close();
                const before = await readFile(path);
                const key = widgetSessionKey({ ...target, sessionId: "fixture-b", sourceHome: "" });
                const sources: WidgetSources = {
                    ...realWidgetSources,
                    sessions: async () => [],
                    decisions: () => [],
                    forms: () => [],
                    agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
                };
                const snapshot = await widgetSnapshot({
                    root: directory,
                    now: FIXTURE_CLOCK,
                    selectedKey: key,
                    sources,
                });
                expect(snapshot.cards).toHaveLength(1);
                expect(snapshot.notifications?.unread).toBe(151);
                expect(snapshot.notifications?.complete).toBe(true);
                expect(snapshot.notifications?.sessions.find((row) => row.unread === 150)).toBeDefined();
                expect(await readFile(path)).toEqual(before);
                await performWidgetAction({
                    root: directory,
                    input: { action: "inbox-read", kind: "answer", key, id: "answer:inbox-150", at: 151 },
                });
                expect(
                    (await widgetSnapshot({ root: directory, now: FIXTURE_CLOCK, selectedKey: key, sources }))
                        .notifications?.unread
                ).toBe(150);
                await expect(
                    performWidgetAction({
                        root: directory,
                        input: { action: "inbox-read", kind: "answer", key, id: "answer:inbox-0", at: 1 },
                    })
                ).rejects.toThrow("different session");
                const afterRead = await readFile(path);
                const log = join(directory, "log");
                await mkdir(log, { recursive: true });
                await writeFile(
                    join(log, "2026-01-01.jsonl"),
                    `${SafeJSON.stringify({
                        id: "fresh-jsonl",
                        ts: Date.now(),
                        sessionId: "fixture-b",
                        sessionTitle: "Fixture",
                        agent: "codex",
                        question: "Fresh",
                        answerMd: "Fresh answer",
                        project: "Fixture",
                        repoRoot: "/fixture",
                        cwd: "/fixture",
                        branch: null,
                        commitSha: null,
                        commitMessage: null,
                        isWorktree: false,
                        worktreePath: null,
                        aiAgent: null,
                        agentLabel: null,
                        tag: "question",
                        refs: [],
                        source: "mcp",
                        turnUuid: null,
                        supersededBy: null,
                        readAt: null,
                    })}\n`
                );
                const fresh = await widgetSnapshot({ root: directory, now: FIXTURE_CLOCK, selectedKey: key, sources });
                expect(fresh.notifications?.unread).toBe(151);
                expect(fresh.notifications?.sessions.find((entry) => entry.key === key)?.unreadItem?.id).toBe(
                    "answer:fresh-jsonl"
                );
                expect(await readFile(path)).toEqual(afterRead);
                await expect(
                    performWidgetAction({
                        root: directory,
                        input: {
                            action: "inbox-read",
                            kind: "answer",
                            key,
                            id: "answer:fresh-jsonl",
                            at: fresh.notifications!.sessions.find((entry) => entry.key === key)!.unreadItem!.at,
                        },
                    })
                ).resolves.toEqual({ read: 1 });
                expect(
                    (await widgetSnapshot({ root: directory, now: FIXTURE_CLOCK, selectedKey: key, sources }))
                        .notifications?.unread
                ).toBe(150);
            }
        );
    });

    test("an old notified card stays in the selected window behind 100 newer cards", async () => {
        const directory = await root();
        await env.testing.withOverrides(
            { GENESIS_TOOLS_HOME: directory, QUESTION_LOG_BASE: join(directory, "log") },
            async () => {
                const db = openReadModel(toolDataDir("question", "qa.db"));
                db.query(
                    "INSERT INTO entries (id,ts,session_id,session_title,agent,question,answer_md,refs_json,project,cwd,source,tag) VALUES ('window-old',1,'fixture-window','Fixture','codex','Question','Answer','[]','Fixture','/fixture','mcp','question')"
                ).run();
                db.close();
                const file = join(directory, "decisions.jsonl");
                await postDecisions(file, join(directory, "events.jsonl"), {
                    sessionId: "fixture-window",
                    provider: "codex",
                    decisions: Array.from({ length: 100 }, (_, index) => ({
                        prompt: `Newer ${index}?`,
                        options: ["yes"],
                    })),
                });
                const key = widgetSessionKey({
                    ...target,
                    sessionId: "fixture-window",
                    sourceHome: "",
                    cwd: "/fixture",
                });
                const sources: WidgetSources = {
                    ...realWidgetSources,
                    sessions: async () => [],
                    decisions: () => readDecisions(file),
                    forms: () => [],
                    agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
                };
                const snapshot = await widgetSnapshot({
                    root: directory,
                    now: FIXTURE_CLOCK,
                    selectedKey: key,
                    sources,
                });
                const session = snapshot.notifications?.sessions.find((entry) => entry.key === key);
                expect(session?.unreadItem?.id).toBe("answer:window-old");
                expect(snapshot.cards).toHaveLength(101);
                expect(snapshot.cards[0]?.id).toBe("answer:window-old");
            }
        );
    });

    test("an answer with an unknown agent counts on the indexed session that owns its id", async () => {
        const directory = await root();
        await env.testing.withOverrides(
            { GENESIS_TOOLS_HOME: directory, QUESTION_LOG_BASE: join(directory, "log") },
            async () => {
                const insertAnswer = (id: string, agent: string) => {
                    const db = openReadModel(toolDataDir("question", "qa.db"));
                    db.query(
                        "INSERT INTO entries (id,ts,session_id,session_title,agent,question,answer_md,refs_json,project,cwd,source,tag) VALUES (?,1,'shared-fixture','Fixture',?,'Question','Answer','[]','Fixture','/fixture','mcp','question')"
                    ).run(id, agent);
                    db.close();
                };
                insertAnswer("agentless-answer", "unknown");
                const sources: WidgetSources = {
                    ...realWidgetSources,
                    sessions: async () => [
                        {
                            provider: "codex",
                            sessionId: "shared-fixture",
                            title: "Indexed",
                            cwd: "/fixture",
                            cwdShort: "fixture",
                            project: "Fixture",
                            mtime: 1,
                            model: null,
                            account: null,
                            filePath: "/fixture/shared.jsonl",
                        },
                    ],
                    decisions: () => [],
                    forms: () => [],
                    agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
                };
                const snapshot = await widgetSnapshot({ root: directory, now: FIXTURE_CLOCK, sources });
                const indexed = snapshot.sessions.find((session) => session.target.provider === "codex");
                expect(indexed).toBeDefined();
                expect(snapshot.sessions.some((session) => session.target.provider === "unknown")).toBe(false);
                const owner = snapshot.notifications?.sessions.find((entry) => entry.key === indexed?.key);
                expect(owner?.unreadItem?.id).toBe("answer:agentless-answer");
                await performWidgetAction({
                    root: directory,
                    input: {
                        action: "inbox-read",
                        kind: "answer",
                        key: indexed!.key,
                        id: "answer:agentless-answer",
                        at: 1,
                    },
                });
                // Control: an answer from a known, different agent still cannot be read through this session.
                insertAnswer("claude-answer", "claude");
                await expect(
                    performWidgetAction({
                        root: directory,
                        input: {
                            action: "inbox-read",
                            kind: "answer",
                            key: indexed!.key,
                            id: "answer:claude-answer",
                            at: 1,
                        },
                    })
                ).rejects.toThrow("different session");
                const after = await widgetSnapshot({ root: directory, now: FIXTURE_CLOCK, sources });
                expect(after.notifications?.sessions.find((entry) => entry.key === indexed?.key)).toBeUndefined();
                expect(after.notifications?.unread).toBe(1);
            }
        );
    });

    test("completed results count once and versioned acknowledgements survive reload", async () => {
        const directory = await root();
        const node: AgentNode = {
            id: "fixture-worker",
            harness: "codex",
            kind: "worker",
            name: "Fixture",
            description: null,
            agentType: null,
            model: null,
            account: null,
            status: "completed",
            startedAt: null,
            lastAt: "2026-01-01T10:00:00Z",
            toolCalls: 0,
            unreadMail: 0,
            team: null,
            backendType: null,
            filePath: null,
            spawnPrompt: null,
            spawnPromptPreview: null,
            toolUseId: null,
            spawnDepth: 0,
            children: [],
        };
        const sources: WidgetSources = {
            sessions: async () => [],
            decisions: () => [],
            forms: () => [],
            answers: () => [],
            agents: async () => ({ generatedAt: "", parents: [], orphans: [node, node] }),
            inboxData: () => ({ answers: [], forms: [], complete: true, truncated: false }),
        };
        const snapshot = await widgetSnapshot({ root: directory, now: FIXTURE_CLOCK, sources });
        expect(snapshot.notifications?.unread).toBe(1);
        const item = snapshot.notifications!.sessions[0].unreadItem!;
        expect(
            await performWidgetAction({
                root: directory,
                input: { action: "inbox-read", kind: "result", key: item.key, id: item.id, at: item.at },
                sources,
            })
        ).toEqual({ saved: true });
        expect(
            await performWidgetAction({
                root: directory,
                input: { action: "inbox-read", kind: "result", key: item.key, id: item.id, at: item.at },
                sources,
            })
        ).toEqual({ saved: false });
        await expect(
            performWidgetAction({
                root: directory,
                input: { action: "inbox-read", kind: "result", key: item.key, id: item.id, at: Number.MAX_VALUE },
                sources,
            })
        ).rejects.toThrow("future");
        await expect(
            performWidgetAction({
                root: directory,
                input: { action: "inbox-read", kind: "result", key: item.key, id: item.id, at: item.at + 1 },
                sources,
            })
        ).rejects.toThrow("newer than the result");
        expect((await widgetSnapshot({ root: directory, now: FIXTURE_CLOCK, sources })).notifications?.unread).toBe(0);
        node.lastAt = "2026-01-01T10:00:01Z";
        expect((await widgetSnapshot({ root: directory, now: FIXTURE_CLOCK, sources })).notifications?.unread).toBe(1);
    });

    test("a worker mapped onto an indexed session keeps its result card, and an idle agent has none", async () => {
        const directory = await root();
        const worker: AgentNode = {
            id: "fixture-mapped-worker",
            harness: "codex",
            kind: "worker",
            name: "Mapped",
            description: null,
            agentType: null,
            model: null,
            account: null,
            status: "completed",
            startedAt: null,
            lastAt: "2026-01-01T10:00:00Z",
            toolCalls: 0,
            unreadMail: 0,
            team: null,
            backendType: null,
            filePath: "/fixture/mapped-worker.jsonl",
            spawnPrompt: null,
            spawnPromptPreview: null,
            toolUseId: null,
            spawnDepth: 0,
            children: [],
        };
        const idle: AgentNode = { ...worker, id: "fixture-idle-worker", status: "idle", filePath: null };
        const sources: WidgetSources = {
            sessions: async () => [
                {
                    provider: "codex",
                    sessionId: "fixture-indexed-thread",
                    title: "Indexed",
                    cwd: "/fixture",
                    cwdShort: "fixture",
                    project: "Fixture",
                    mtime: 1,
                    model: null,
                    account: null,
                    filePath: "/fixture/mapped-worker.jsonl",
                },
            ],
            decisions: () => [],
            forms: () => [],
            answers: () => [],
            agents: async () => ({ generatedAt: "", parents: [], orphans: [worker, idle] }),
            inboxData: () => ({ answers: [], forms: [], complete: true, truncated: false }),
        };
        const snapshot = await widgetSnapshot({ root: directory, now: FIXTURE_CLOCK, sources });
        expect(snapshot.notifications?.unread).toBe(1);
        const item = snapshot.notifications!.sessions[0].unreadItem!;
        expect(parseWidgetSessionKey(item.key)?.sessionId).toBe("fixture-indexed-thread");
        expect(snapshot.cards.filter((card) => card.kind === "result").map((card) => card.sourceId)).toEqual([
            "fixture-mapped-worker",
        ]);
        expect(
            await performWidgetAction({
                root: directory,
                input: { action: "inbox-read", kind: "result", key: item.key, id: item.id, at: item.at },
                sources,
            })
        ).toEqual({ saved: true });
        expect((await widgetSnapshot({ root: directory, now: FIXTURE_CLOCK, sources })).notifications?.unread).toBe(0);
        const foreign = widgetSessionKey({ ...target, sessionId: "fixture-other-thread", sourceHome: "" });
        await expect(
            performWidgetAction({
                root: directory,
                input: { action: "inbox-read", kind: "result", key: foreign, id: item.id, at: item.at },
                sources,
            })
        ).rejects.toThrow("different session");
    });

    test("reading a pending question leaves its needs-answer state intact", async () => {
        const directory = await root();
        const key = widgetSessionKey({ ...target, sessionId: "pending-fixture", sourceHome: "" });
        const sources: WidgetSources = {
            sessions: async () => [],
            decisions: () => [],
            forms: () => [],
            answers: () => [],
            agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
            inboxData: (window) => ({
                answers: [],
                forms: [
                    {
                        id: "pending-one",
                        sessionId: "pending-fixture",
                        provider: "codex",
                        title: "Question",
                        project: "Fixture",
                        cwd: "/fixture",
                        at: 1,
                        count: 1,
                        ...inboxWindowCounts([1], window),
                        total: 1,
                    },
                ],
                complete: true,
                truncated: false,
            }),
        };
        expect(
            (await widgetSnapshot({ root: directory, now: FIXTURE_CLOCK, sources })).notifications?.needsAnswer
        ).toBe(1);
        await performWidgetAction({
            root: directory,
            input: { action: "inbox-read", kind: "form", key, id: "form:pending-one", at: 1 },
        });
        expect(
            (await widgetSnapshot({ root: directory, now: FIXTURE_CLOCK, sources })).notifications?.needsAnswer
        ).toBe(1);
        expect((await readWidgetState(directory)).inboxRead[`${key}|form:pending-one`]).toBe(1);
    });

    test("a full inbox read history forgets its oldest marks instead of refusing new reads", async () => {
        const directory = await root();
        const key = widgetSessionKey({ ...target, sessionId: "history-fixture", sourceHome: "" });
        await mutateWidgetState(directory, (state) => {
            for (let index = 0; index < 4096; index++) {
                state.inboxRead[`${key}|form:old-${index}`] = index;
            }
        });
        await performWidgetAction({
            root: directory,
            input: { action: "inbox-read", kind: "form", key, id: "form:newest", at: 10_000 },
        });
        const history = (await readWidgetState(directory)).inboxRead;
        expect(history[`${key}|form:newest`]).toBe(10_000);
        expect(history[`${key}|form:old-0`]).toBeUndefined();
        expect(history[`${key}|form:old-4095`]).toBe(4095);
        expect(Object.keys(history).length).toBeLessThan(4096);
    });

    test("a quiet session's old items stop counting, and Mark all read clears the rest without hiding them", async () => {
        const directory = await root();
        await env.testing.withOverrides(
            { GENESIS_TOOLS_HOME: directory, QUESTION_LOG_BASE: join(directory, "log") },
            async () => {
                const now = Date.now();
                const hour = 60 * 60 * 1000;
                const decision = (sessionId: string, at: number): DecisionRecord => ({
                    id: `d_1_${sessionId}`,
                    sessionId,
                    provider: "codex",
                    number: 1,
                    prompt: `Decide for ${sessionId}?`,
                    options: ["yes", "no"],
                    state: "open",
                    updatedTs: new Date(at).toISOString(),
                });
                let decisions = [decision("ended-fixture", now - 240 * hour), decision("live-fixture", now - hour)];
                const group = (sessionId: string, at: number, count: number, window: WidgetInboxWindow) => ({
                    id: `${sessionId}-newest`,
                    sessionId,
                    provider: "codex",
                    title: "Fixture",
                    project: "Fixture",
                    cwd: "/fixture",
                    at,
                    count,
                    ...inboxWindowCounts(Array<number>(count).fill(at), window),
                    total: count,
                });
                const sources: WidgetSources = {
                    sessions: async () => [],
                    decisions: () => decisions,
                    forms: () => [],
                    answers: () => [],
                    agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
                    inboxData: (window) => ({
                        answers: [group("answer-fixture", now - 10 * 60 * 1000, 2, window)],
                        forms: [group("form-fixture", now - 120 * hour, 3, window)],
                        complete: true,
                        truncated: false,
                    }),
                };
                const ended = widgetSessionKey({ ...target, sessionId: "ended-fixture", sourceHome: "" });
                const first = await widgetSnapshot({ root: directory, selectedKey: ended, sources, now });
                expect(first.notifications).toMatchObject({ unread: 2, needsAnswer: 1 });
                expect(first.notifications?.sessions.map((entry) => entry.key)).not.toContain(ended);
                // Still reachable: the session and its card stay, the session just no longer looks like it waits.
                expect(first.sessions.find((session) => session.key === ended)?.status).toBe("recent");
                expect(first.cards.map((card) => card.id)).toContain("decision:d_1_ended-fixture");

                const db = openReadModel(toolDataDir("question", "qa.db"));
                const insert = db.query(
                    "INSERT INTO entries (id,ts,session_id,session_title,agent,question,answer_md,refs_json,project,cwd,source,tag) VALUES (?,?,'answer-fixture','Fixture','codex','Question','Answer','[]','Fixture','/fixture','mcp','question')"
                );
                insert.run("before-clear", now - 1000);
                insert.run("after-clear", now + 30_000);
                db.close();
                await expect(
                    performWidgetAction({ root: directory, input: { action: "inbox-clear", at: now + 5 * 60 * 1000 } })
                ).rejects.toThrow("future");
                expect(
                    await performWidgetAction({ root: directory, input: { action: "inbox-clear", at: now } })
                ).toEqual({ read: 1, clearedAt: now });
                const check = openReadModel(toolDataDir("question", "qa.db"));
                const readAt = (id: string) =>
                    check
                        .query<{ read_at: number | null }, [string]>("SELECT read_at FROM entries WHERE id = ?")
                        .get(id)?.read_at;
                expect(readAt("before-clear")).not.toBeNull();
                expect(readAt("after-clear")).toBeNull();
                check.close();

                const cleared = await widgetSnapshot({ root: directory, sources, now });
                expect(cleared.notifications).toMatchObject({ unread: 0, needsAnswer: 0 });
                expect(cleared.sessions.find((session) => session.key.includes("live-fixture"))?.status).toBe(
                    "waiting"
                );
                decisions = [...decisions, decision("new-fixture", now + 1000)];
                expect((await widgetSnapshot({ root: directory, sources, now })).notifications?.needsAnswer).toBe(1);
            }
        );
    });

    test("a new question after Mark all read counts alone, never with the session's cleared ones", async () => {
        const directory = await root();
        await env.testing.withOverrides(
            { GENESIS_TOOLS_HOME: directory, QUESTION_LOG_BASE: join(directory, "log") },
            async () => {
                const now = Date.now();
                const post = (id: string, at: number) => {
                    const db = openPendingStore(toolDataDir("question", "qa.db"));
                    db.query(
                        "INSERT INTO qa_pending (id,created_at,status,source,session_hint,project_path,cwd,items_json) VALUES (?,?,'pending','Question','form-fixture','/fixture','/fixture','[]')"
                    ).run(id, at);
                    db.close();
                };
                for (const [index, at] of [now - 3000, now - 2000, now - 1000].entries()) {
                    post(`cleared-${index}`, at);
                }
                // The real SQL source, so the per-item counts are what qa.db holds.
                const sources: WidgetSources = {
                    sessions: async () => [],
                    decisions: () => [],
                    forms: () => [],
                    answers: () => [],
                    agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
                    inboxData: realWidgetSources.inboxData,
                };
                const needsAnswer = async (at: number) =>
                    (await widgetSnapshot({ root: directory, sources, now: at })).notifications?.needsAnswer;
                expect(await needsAnswer(now)).toBe(3);
                await performWidgetAction({ root: directory, input: { action: "inbox-clear", at: now } });
                expect(await needsAnswer(now)).toBe(0);

                post("after-clear", now + 1000);
                expect(await needsAnswer(now + 2000)).toBe(1);
            }
        );
    });
});

describe("private Widget voice notes", () => {
    async function fixture() {
        const root = await mkdtemp(join(tmpdir(), "widget-voice-"));
        const input = join(root, "synthetic.pcm");
        await Bun.write(input, new Uint8Array(3200));
        const note = await recordVoiceNote({ root, input });
        return { root, input, note };
    }
    test("local record, explicit fixture transcription, edit and guarded discard use one private note", async () => {
        const { root, input, note } = await fixture();
        expect((await files.stat(note.clip.path)).mode & 0o777).toBe(0o600);
        expect((await files.stat(join(root, "voice-notes"))).mode & 0o777).toBe(0o700);
        expect((await files.stat(join(root, "voice-notes", "notes.json"))).mode & 0o777).toBe(0o600);
        expect(note.transcription).toBe("none");
        expect(note.text).toBe("");
        expect((await listVoiceNotes(root)).notes).toHaveLength(1);
        expect(await Bun.file(input).bytes()).toEqual(await Bun.file(note.clip.path).bytes());
        const result = await transcribeVoiceNote({
            root,
            id: note.id,
            expectedRevision: 1,
            provider: "fixture",
            events: [{ kind: "final", text: "Remember the test", isFinal: true, startedAtMs: 0 }],
        });
        expect(result.text).toBe("Remember the test");
        const edited = await editVoiceNote({
            root,
            id: note.id,
            expectedRevision: result.revision,
            text: "Reviewed thought",
        });
        expect(edited.text).toBe("Reviewed thought");
        await expect(editVoiceNote({ root, id: note.id, expectedRevision: 1, text: "stale" })).rejects.toThrow(
            "changed"
        );
        await expect(discardVoiceNote({ root, id: note.id, expectedRevision: 1 })).rejects.toThrow("changed");
        await discardVoiceNote({ root, id: note.id, expectedRevision: edited.revision });
        expect((await listVoiceNotes(root)).notes).toEqual([]);
        expect(await Bun.file(note.clip.path).exists()).toBe(false);
        expect(await Bun.file(input).exists()).toBe(true);
        const absent = join(root, "absent");
        expect((await listVoiceNotes(absent)).notes).toEqual([]);
        expect(await Bun.file(join(absent, "voice-notes", "notes.json")).exists()).toBe(false);
    });
    test("multibyte metadata stays readable near its byte limit and oversized edits preserve saved bytes", async () => {
        const { root, note } = await fixture();
        const limit = 16 * 1024 * 1024;
        const notes = Array.from({ length: 100 }, (_, index) => ({
            ...note,
            id: randomUUID(),
            text: index === 99 ? "" : "ž".repeat(42_000),
            recognizedText: index === 99 ? "" : "ž".repeat(42_000),
        }));
        const target = notes[99];
        const index = { revision: 1, notes };
        const remaining = Math.floor((limit - 1024 - Buffer.byteLength(SafeJSON.stringify(index), "utf8")) / 2);
        expect(remaining).toBeGreaterThan(0);
        expect(remaining).toBeLessThanOrEqual(64_000);
        target.recognizedText = "ž".repeat(remaining);
        const path = join(root, "voice-notes", "notes.json");
        await Bun.write(path, SafeJSON.stringify(index));
        const saved = await editVoiceNote({ root, id: target.id, expectedRevision: 1, text: "ž".repeat(256) });
        expect(saved.text).toBe("ž".repeat(256));
        const before = await readFile(path);
        expect(before.length).toBeGreaterThan(limit - 2048);
        expect(before.length).toBeLessThanOrEqual(limit);
        expect((await listVoiceNotes(root)).notes.find((item) => item.id === target.id)?.revision).toBe(2);
        const rejected = await editVoiceNote({
            root,
            id: target.id,
            expectedRevision: saved.revision,
            text: "ž".repeat(64_000),
        }).then(
            () => false,
            (error: unknown) => error instanceof Error && error.message.includes("metadata")
        );
        const after = await readFile(path);
        const readable = await listVoiceNotes(root).then(
            () => true,
            () => false
        );
        expect({ rejected, unchangedBytes: before.equals(after), readable }).toEqual({
            rejected: true,
            unchangedBytes: true,
            readable: true,
        });
    });

    test("late transcription preserves a concurrent edit, failure keeps audio and retry works", async () => {
        const { root, note } = await fixture();
        let complete!: (text: string) => void;
        let opened!: () => void;
        const started = new Promise<void>((resolve) => {
            opened = resolve;
        });
        const done = new Promise<string>((resolve) => {
            complete = resolve;
        });
        const pending = transcribeVoiceNote({
            root,
            id: note.id,
            expectedRevision: 1,
            provider: "fixture",
            createSession: async () => {
                opened();
                return { provider: "fixture", stop() {}, done };
            },
        });
        await started;
        await editVoiceNote({ root, id: note.id, expectedRevision: 1, text: "My concurrent edit" });
        complete("Recognized words");
        const result = await pending;
        expect(result.text).toBe("My concurrent edit");
        expect(result.recognizedText).toBe("Recognized words");
        await expect(
            transcribeVoiceNote({
                root,
                id: note.id,
                expectedRevision: result.revision,
                provider: "fixture",
                createSession: async () => {
                    throw new Error("synthetic service error");
                },
            })
        ).rejects.toThrow("synthetic service error");
        const failed = (await listVoiceNotes(root)).notes[0]!;
        expect(failed.transcription).toBe("failed");
        expect(await Bun.file(failed.clip.path).exists()).toBe(true);
        const retry = await transcribeVoiceNote({
            root,
            id: note.id,
            expectedRevision: failed.revision,
            provider: "fixture",
            events: [{ kind: "final", text: "Retry succeeds", isFinal: true, startedAtMs: 0 }],
        });
        expect(retry.text).toBe("Retry succeeds");
        expect(retry.error).toBeUndefined();
    });
    test("a note whose clip was deleted outside the tool can still be discarded", async () => {
        const { root, note } = await fixture();
        await unlink(note.clip.path);
        await expect(discardVoiceNote({ root, id: note.id, expectedRevision: note.revision })).resolves.toEqual({
            discarded: true,
            id: note.id,
        });
        expect((await listVoiceNotes(root)).notes).toHaveLength(0);
    });
    test("a clip that cannot be removed keeps its note listed so discard can be retried", async () => {
        const { root, note } = await fixture();
        const clips = join(root, "voice-notes", "clips");
        await files.chmod(clips, 0o500);
        try {
            await expect(discardVoiceNote({ root, id: note.id, expectedRevision: note.revision })).rejects.toThrow();
            expect((await listVoiceNotes(root)).notes.map((item) => item.id)).toEqual([note.id]);
        } finally {
            await files.chmod(clips, 0o700);
        }

        await discardVoiceNote({ root, id: note.id, expectedRevision: note.revision });
        expect((await listVoiceNotes(root)).notes).toEqual([]);
        expect(await Bun.file(note.clip.path).exists()).toBe(false);
    });
    test("a recording that loses the last notebook slot is discarded instead of orphaned", async () => {
        const { root, input, note } = await fixture();
        const full = { revision: 1, notes: Array.from({ length: 100 }, () => ({ ...note, id: randomUUID() })) };
        const id = randomUUID();
        await expect(
            recordVoiceNote({
                root,
                id,
                input,
                onEvent: (event) => {
                    if (event.kind === "recording") {
                        writeFileSync(join(root, "voice-notes", "notes.json"), SafeJSON.stringify(full));
                    }
                },
            })
        ).rejects.toThrow("discarded");
        expect(await Bun.file(join(root, "voice-notes", "clips", `${id}.pcm`)).exists()).toBe(false);
        expect(await Bun.file(note.clip.path).exists()).toBe(true);
    });
    test("a late failure of an older transcription cannot replace a newer success", async () => {
        const { root, note } = await fixture();
        let fail!: (error: Error) => void;
        let opened!: () => void;
        const started = new Promise<void>((resolve) => {
            opened = resolve;
        });
        const older = transcribeVoiceNote({
            root,
            id: note.id,
            expectedRevision: 1,
            provider: "fixture",
            createSession: async () => {
                opened();
                const done = new Promise<string>((_, reject) => {
                    fail = reject;
                });
                return { provider: "fixture", stop() {}, done };
            },
        });
        await started;
        const newer = await transcribeVoiceNote({
            root,
            id: note.id,
            expectedRevision: 1,
            provider: "fixture",
            events: [{ kind: "final", text: "Newer words", isFinal: true, startedAtMs: 0 }],
        });
        expect(newer.transcription).toBe("ready");
        fail(new Error("synthetic late failure"));
        await expect(older).rejects.toThrow("synthetic late failure");
        const saved = (await listVoiceNotes(root)).notes[0]!;
        expect({ transcription: saved.transcription, text: saved.text, error: saved.error }).toEqual({
            transcription: "ready",
            text: "Newer words",
            error: undefined,
        });
    });
    test("redirected private clip paths cannot open a provider", async () => {
        const { root, input, note } = await fixture();
        await unlink(note.clip.path);
        await files.symlink(input, note.clip.path);
        let opened = 0;
        await expect(
            transcribeVoiceNote({
                root,
                id: note.id,
                expectedRevision: 1,
                provider: "fixture",
                createSession: async () => {
                    opened++;
                    throw new Error("must never open");
                },
            })
        ).rejects.toThrow("outside its private");
        expect(opened).toBe(0);
        expect(await Bun.file(input).exists()).toBe(true);
    });
    test("cancelled transcription cannot write and tampered audio cannot open a provider", async () => {
        const { root, note } = await fixture();
        const abort = new AbortController();
        let opened = 0;
        await expect(
            transcribeVoiceNote({
                root,
                id: note.id,
                expectedRevision: 1,
                provider: "fixture",
                signal: abort.signal,
                createSession: async () => {
                    opened++;
                    abort.abort();
                    return { provider: "fixture", stop() {}, done: Promise.resolve("late") };
                },
            })
        ).rejects.toThrow();
        expect(opened).toBe(1);
        expect((await listVoiceNotes(root)).notes[0]?.revision).toBe(1);
        await Bun.write(note.clip.path, new Uint8Array(3200).fill(2));
        await expect(
            transcribeVoiceNote({
                root,
                id: note.id,
                expectedRevision: 1,
                provider: "fixture",
                createSession: async () => {
                    opened++;
                    throw new Error("must not open");
                },
            })
        ).rejects.toThrow("audio changed");
        expect(opened).toBe(1);
    });
});

test("native capture exit classification keeps cancellation separate from permission and process failures", async () => {
    const directory = await root();
    expect(await captureShelfImage({ root: directory, capture: async () => ({ status: 0, stderr: "" }) })).toEqual({
        cancelled: true,
        reason: "user",
    });
    expect((await listWidgetShelf(directory)).items).toEqual([]);
    const denied = await captureShelfImage({
        root: directory,
        capture: async () => ({ status: 1, stderr: "could not create image from window\n" }),
    }).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(ScreenRecordingDeniedError);
    expect(denied instanceof ScreenRecordingDeniedError && denied.code).toBe(SCREEN_RECORDING_DENIED);
    expect(denied instanceof Error && denied.message).toStartWith(`[${SCREEN_RECORDING_DENIED}]`);
    expect(denied instanceof Error && denied.message).toContain("could not create image from window");
    await expect(
        captureShelfImage({ root: directory, capture: async () => ({ status: 2, stderr: "disk full\n" }) })
    ).rejects.toThrow("Screenshot capture failed: disk full");
    await expect(
        captureShelfImage({
            root: directory,
            capture: async () => ({ status: 0, error: new Error("Capture timed out") }),
        })
    ).rejects.toThrow("Capture timed out");
    expect((await listWidgetShelf(directory)).items).toEqual([]);
    expect((await readWidgetState(directory)).drafts).toEqual({});
});

test("a capture plays the shutter sound unless interface sound effects are off", async () => {
    const directory = await root();
    const commands: string[][] = [];
    const record: ScreenshotRunner = async ({ command }) => {
        commands.push(command);
        return { status: 0, stderr: "" };
    };
    await captureShelfImage({ root: directory, capture: record, soundEnabled: async () => true });
    await captureShelfImage({ root: directory, capture: record, soundEnabled: async () => false });
    expect(commands.map((command) => command.slice(0, -1))).toEqual([
        ["/usr/sbin/screencapture", "-i"],
        ["/usr/sbin/screencapture", "-i", "-x"],
    ]);
    expect(parseUiSoundSetting({ status: 0, stdout: "0\n" })).toBe(false);
    expect(parseUiSoundSetting({ status: 0, stdout: "1\n" })).toBe(true);
    // The key is absent until the user flips the switch once: macOS plays sounds then.
    expect(parseUiSoundSetting({ status: 1, stdout: "" })).toBe(true);
});

test("screenshot classification separates Escape, a missing grant and other failures", () => {
    expect(classifyScreenshot({ status: 0, stderr: "", outputExists: true })).toEqual({ kind: "captured" });
    expect(classifyScreenshot({ status: 0, stderr: "", outputExists: false })).toEqual({ kind: "cancelled" });
    expect(classifyScreenshot({ status: 1, stderr: "", outputExists: false })).toEqual({ kind: "cancelled" });
    expect(
        classifyScreenshot({ status: 1, stderr: "could not create image from display", outputExists: false })
    ).toEqual({
        kind: "denied",
        detail: "could not create image from display",
    });
    expect(classifyScreenshot({ status: null, error: new Error("timed out"), outputExists: false })).toEqual({
        kind: "failed",
        detail: "timed out",
    });
    expect(classifyScreenshot({ status: 3, stderr: "disk full", outputExists: false })).toEqual({
        kind: "failed",
        detail: "disk full",
    });
});

test("the composer capture action returns Escape as a typed result and a missing grant as a typed error", async () => {
    const directory = await root();
    const key = widgetSessionKey(target);
    expect(
        await performWidgetAction({
            root: directory,
            input: { action: "capture", key },
            capture: async () => ({ status: 0, stderr: "" }),
        })
    ).toEqual({ cancelled: true, reason: "user" });
    await expect(
        performWidgetAction({
            root: directory,
            input: { action: "capture", key },
            capture: async () => ({ status: 1, stderr: "could not create image from window" }),
        })
    ).rejects.toBeInstanceOf(ScreenRecordingDeniedError);
    expect((await readWidgetState(directory)).drafts).toEqual({});
});

describe("portable session queue delivery", () => {
    test("unowned sessions stay pending until exact consumer ACK, retain ordering, and cancel only their own unoffered payload", async () => {
        const directory = await root();
        const queueRoot = join(directory, "session-queue");
        let transportCalls = 0;
        const dispatcher = widgetDispatcher({
            deliver: {
                queueRoot,
                codexWorkerFor: () => null,
                runTool: async () => {
                    transportCalls += 1;
                    throw new Error("No owner: must not spawn another session");
                },
            },
        });
        const first = await enqueue(directory, "First queued payload");
        const second = await enqueue(directory, "Second queued payload");
        await processWidgetOutbox({ root: directory, dispatcher, queueRoot });
        let state = await readWidgetState(directory);
        expect(state.outgoing.map((message) => message.state)).toEqual(["waiting-route", "queued"]);
        const queueTarget = { ...target, provider: "codex" as const };
        const [queued] = listSessionMessages({ target: queueTarget, root: queueRoot });
        expect(queued.text).toContain("First queued payload");
        expect(state.outgoing[0].receipt?.delivered).toBe(false);
        await offerSessionMessage({ target: queueTarget, root: queueRoot, id: queued.id, consumer: "fixture-agent" });
        await processWidgetOutbox({ root: directory, dispatcher, queueRoot });
        expect((await readWidgetState(directory)).outgoing[0].state).toBe("waiting-route");
        await expect(changeOutgoing({ root: directory, id: first.id, action: "retry", queueRoot })).rejects.toThrow(
            "may already have reached"
        );
        await expect(changeOutgoing({ root: directory, id: first.id, action: "cancel", queueRoot })).rejects.toThrow(
            "may already have reached"
        );
        await acknowledgeSessionMessage({
            target: queueTarget,
            root: queueRoot,
            id: queued.id,
            consumer: "fixture-agent",
        });
        await processWidgetOutbox({ root: directory, dispatcher, queueRoot });
        state = await readWidgetState(directory);
        expect(state.outgoing.map((message) => message.state)).toEqual(["sent", "waiting-route"]);
        expect(state.outgoing[0].receipt).toMatchObject({
            delivered: true,
            entryId: queued.id,
            detail: "Received by fixture-agent",
        });
        await changeOutgoing({ root: directory, id: second.id, action: "cancel", queueRoot });
        expect(listSessionMessages({ target: queueTarget, root: queueRoot }).map((message) => message.state)).toEqual([
            "received",
            "cancelled",
        ]);
        expect(transportCalls).toBe(0);
    });

    test("an acknowledgement the queue pruned while the widget was away still confirms the reply", async () => {
        const directory = await root();
        const queueRoot = join(directory, "session-queue");
        const dispatcher = widgetDispatcher({ deliver: { queueRoot, codexWorkerFor: () => null } });
        await enqueue(directory, "Payload acknowledged long ago");
        await processWidgetOutbox({ root: directory, dispatcher, queueRoot });
        const queueTarget = { ...target, provider: "codex" as const };
        const [queued] = listSessionMessages({ target: queueTarget, root: queueRoot });
        await offerSessionMessage({ target: queueTarget, root: queueRoot, id: queued.id, consumer: "fixture-agent" });
        await acknowledgeSessionMessage({
            target: queueTarget,
            root: queueRoot,
            id: queued.id,
            consumer: "fixture-agent",
        });
        // The widget is away for eight days; another producer's write then prunes the old acknowledgement.
        const [name] = (await readdir(queueRoot)).filter((entry) => entry.endsWith(".json"));
        const file = join(queueRoot, name);
        const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
        const aged = z
            .array(z.object({ updatedAt: z.string() }).passthrough())
            .parse(SafeJSON.parse(await readFile(file, "utf8"), { strict: true }))
            .map((message) => ({ ...message, updatedAt: longAgo }));
        await writeFile(file, SafeJSON.stringify(aged));
        await enqueueSessionMessage({ target: queueTarget, root: queueRoot, text: "Another producer's message" });
        expect(listSessionMessages({ target: queueTarget, root: queueRoot }).map((entry) => entry.id)).not.toContain(
            queued.id
        );

        await processWidgetOutbox({ root: directory, dispatcher, queueRoot });
        expect((await readWidgetState(directory)).outgoing[0]).toMatchObject({
            state: "sent",
            receipt: { delivered: true, entryId: queued.id, detail: "Received by fixture-agent" },
        });
    });

    test("one unreadable session queue does not stop another session's acknowledgement", async () => {
        const directory = await root();
        const queueRoot = join(directory, "session-queue");
        const dispatcher = widgetDispatcher({ deliver: { queueRoot, codexWorkerFor: () => null } });
        const other = { ...target, sessionId: "other-session" };
        await enqueue(directory, "Payload for the broken queue", other);
        await enqueue(directory, "Payload for the healthy queue");
        await processWidgetOutbox({ root: directory, dispatcher, queueRoot });
        for (const name of await readdir(queueRoot)) {
            const path = join(queueRoot, name);
            if (name.endsWith(".json") && (await readFile(path, "utf8")).includes("broken queue")) {
                await writeFile(path, "not a queue");
            }
        }
        const queueTarget = { ...target, provider: "codex" as const };
        const [queued] = listSessionMessages({ target: queueTarget, root: queueRoot });
        await offerSessionMessage({ target: queueTarget, root: queueRoot, id: queued.id, consumer: "fixture-agent" });
        await acknowledgeSessionMessage({
            target: queueTarget,
            root: queueRoot,
            id: queued.id,
            consumer: "fixture-agent",
        });
        await processWidgetOutbox({ root: directory, dispatcher, queueRoot });
        expect((await readWidgetState(directory)).outgoing.map((message) => message.state)).toEqual([
            "waiting-route",
            "sent",
        ]);
    });

    test("editing a queued message restores its draft even when a reconcile cancelled it first", async () => {
        const directory = await root();
        const queueRoot = join(directory, "session-queue");
        const dispatcher = widgetDispatcher({ deliver: { queueRoot, codexWorkerFor: () => null } });
        const message = await enqueue(directory, "Edit me after a racing reconcile");
        await processWidgetOutbox({ root: directory, dispatcher, queueRoot });
        const cancel = queueModule.cancelSessionMessage;
        let raced: string | undefined;
        const racing = spyOn(queueModule, "cancelSessionMessage").mockImplementation(async (input) => {
            const cancelled = await cancel(input);
            await processWidgetOutbox({ root: directory, dispatcher, queueRoot });
            raced = (await readWidgetState(directory)).outgoing[0].state;
            return cancelled;
        });
        try {
            await changeOutgoing({ root: directory, id: message.id, action: "edit", queueRoot });
        } finally {
            racing.mockRestore();
        }
        expect(raced).toBe("cancelled");
        const state = await readWidgetState(directory);
        expect(state.outgoing[0].state).toBe("cancelled");
        expect(state.drafts[widgetSessionKey(target)]?.text).toBe("Edit me after a racing reconcile");
    });

    test("an ACK cannot confirm a changed outgoing payload revision", async () => {
        const directory = await root();
        const queueRoot = join(directory, "session-queue");
        const dispatcher = widgetDispatcher({ deliver: { queueRoot, codexWorkerFor: () => null } });
        const message = await enqueue(directory, "Original payload");
        await processWidgetOutbox({ root: directory, dispatcher, queueRoot });
        const queueTarget = { ...target, provider: "codex" as const };
        const [queued] = listSessionMessages({ target: queueTarget, root: queueRoot });
        await offerSessionMessage({ target: queueTarget, root: queueRoot, id: queued.id, consumer: "fixture-agent" });
        await mutateWidgetState(directory, (state) => {
            const current = state.outgoing.find((entry) => entry.id === message.id)!;
            if (current.payload.kind === "followup") {
                current.payload.text = "Changed after offer";
            }
        });
        await acknowledgeSessionMessage({
            target: queueTarget,
            root: queueRoot,
            id: queued.id,
            consumer: "fixture-agent",
        });
        await processWidgetOutbox({ root: directory, dispatcher, queueRoot });
        expect((await readWidgetState(directory)).outgoing[0]).toMatchObject({
            state: "unknown",
            receipt: { delivered: false },
        });
    });
});

test("the Widget action can cancel a Decision answer it queued itself", async () => {
    const directory = await root();
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: directory }, async () => {
        const decisions = decisionFiles();
        const [row] = await postDecisions(
            decisions.file,
            decisions.events,
            { sessionId: target.sessionId, provider: "codex", decisions: [{ prompt: "Queued?", options: ["yes"] }] },
            { env: {} }
        );
        const message = await enqueueWidgetMessage({
            root: directory,
            id: randomUUID(),
            target,
            assetIds: [],
            payload: { kind: "decision", id: row.id, number: row.number, expectedRevision: 1, option: "a", text: "" },
        });
        const dispatcher = widgetDispatcher({ files: decisions, deliver: { codexWorkerFor: () => null } });
        await processWidgetOutbox({ root: directory, dispatcher, decisions });
        expect(readDecisions(decisions.file)[0].delivery?.queueId).toBeDefined();
        await expect(
            performWidgetAction({ root: directory, input: { action: "cancel", id: message.id } })
        ).resolves.toEqual({ updated: true });
        expect(readDecisions(decisions.file)[0].state).toBe("open");
        expect((await readWidgetState(directory)).outgoing[0].state).toBe("cancelled");
    });
});

test("queued Decision ACK and cancellation reconcile the exact canonical answer without prompt-hook replay", async () => {
    const directory = await root();
    const queueRoot = join(directory, "session-queue");
    const decisions = { file: join(directory, "decisions.jsonl"), events: join(directory, "events.jsonl") };
    const rows = await postDecisions(
        decisions.file,
        decisions.events,
        {
            sessionId: target.sessionId,
            provider: "codex",
            decisions: [
                { prompt: "First?", options: ["yes"] },
                { prompt: "Second?", options: ["no"] },
            ],
        },
        { env: {} }
    );
    for (const row of rows) {
        await enqueueWidgetMessage({
            root: directory,
            id: randomUUID(),
            target,
            assetIds: [],
            payload: {
                kind: "decision",
                id: row.id,
                number: row.number,
                expectedRevision: 1,
                option: "a",
                text: "",
            },
        });
    }
    const dispatcher = widgetDispatcher({ files: decisions, deliver: { queueRoot, codexWorkerFor: () => null } });
    await processWidgetOutbox({ root: directory, dispatcher, queueRoot, decisions });
    const queueTarget = { ...target, provider: "codex" as const };
    const [queued] = listSessionMessages({ target: queueTarget, root: queueRoot });
    expect(queued.text).toContain("DECISION 1: a)");
    expect(() => deliverDecisions(readDecisions(decisions.file), () => {})).toThrow("nothing to send");
    await offerSessionMessage({ target: queueTarget, root: queueRoot, id: queued.id, consumer: "fixture-agent" });
    await acknowledgeSessionMessage({ target: queueTarget, root: queueRoot, id: queued.id, consumer: "fixture-agent" });
    await processWidgetOutbox({ root: directory, dispatcher, queueRoot, decisions });
    expect(readDecisions(decisions.file).map((row) => row.state)).toEqual(["sent", "answered"]);
    const second = (await readWidgetState(directory)).outgoing[1];
    await changeOutgoing({ root: directory, id: second.id, action: "cancel", queueRoot, decisions });
    expect(readDecisions(decisions.file).map((row) => row.state)).toEqual(["sent", "open"]);
    expect(readDecisions(decisions.file)[1].delivery?.queueId).toBeUndefined();
});

test("widget agent tree reuses native identity, metadata and nested parent keys", async () => {
    const node = (id: string, children: AgentNode[] = []): AgentNode => ({
        id,
        harness: "codex",
        kind: "worker",
        name: id,
        description: null,
        agentType: null,
        model: "gpt-6.1-sol",
        account: "work",
        status: "running",
        startedAt: "2026-01-01T10:00:00Z",
        lastAt: "2026-01-01T10:01:00Z",
        toolCalls: 17,
        unreadMail: 0,
        team: null,
        backendType: null,
        filePath: `/fixture/${id}.jsonl`,
        spawnPrompt: null,
        spawnPromptPreview: null,
        toolUseId: null,
        spawnDepth: 1,
        children,
    });
    const child = node("worker-name", [node("nested")]);
    const crossProvider = { ...node("cross-provider"), harness: "grok" as const };
    const sources: WidgetSources = {
        sessions: async () => [
            {
                ...target,
                provider: "codex",
                title: "Parent",
                project: "Fixture",
                cwdShort: "Fixture",
                mtime: 1,
                model: "gpt-6-astra",
                account: "personal",
                filePath: "/fixture/lead.jsonl",
            },
            {
                ...target,
                provider: "codex",
                sessionId: "native-child-id",
                sourceHome: "/fixture/child-home",
                title: "Indexed child",
                project: "Fixture",
                cwdShort: "Fixture",
                mtime: 1,
                model: null,
                account: null,
                filePath: "/fixture/worker-name.jsonl",
            },
        ],
        decisions: () => [],
        forms: () => [],
        answers: () => [],
        agents: async () => ({
            generatedAt: "",
            orphans: [],
            parents: [
                {
                    sessionId: target.sessionId,
                    provider: "codex",
                    title: "Parent",
                    project: "Fixture",
                    cwd: target.cwd,
                    filePath: "/fixture/lead.jsonl",
                    model: "gpt-6-astra",
                    account: "personal",
                    startedAt: null,
                    lastAt: "2026-01-01T10:00:00Z",
                    live: true,
                    children: [child, crossProvider],
                },
            ],
        }),
    };
    const snapshot = await widgetSnapshot({ root: await root(), sources });
    const parent = snapshot.sessions.find((entry) => entry.target.sessionId === target.sessionId)!;
    const worker = snapshot.sessions.find((entry) => entry.agentId === child.id)!;
    const nested = snapshot.sessions.find((entry) => entry.agentId === "nested")!;
    expect(snapshot.sessions).toHaveLength(4);
    expect(parent).toMatchObject({ role: "lead", model: "gpt-6-astra", status: "working" });
    expect(worker).toMatchObject({
        title: "worker-name",
        role: "worker",
        model: "gpt-6.1-sol",
        toolCalls: 17,
        startedAt: Date.parse(child.startedAt!),
        parentKey: parent.key,
        target: { sessionId: "native-child-id", sourceHome: "/fixture/child-home" },
    });
    expect(nested.parentKey).toBe(worker.key);
    expect(nested.parentSessionId).toBe("native-child-id");
    expect(snapshot.sessions.find((entry) => entry.agentId === "cross-provider")?.target.sourceHome).toBe("");
});

test("a codex or grok worker row targets its native session and its own home, so a reply can reach it", async () => {
    const worker = (id: string, harness: "codex" | "grok", native: string, home: string): AgentNode => ({
        id,
        harness,
        kind: "worker",
        name: id,
        description: null,
        agentType: null,
        model: null,
        account: null,
        status: "completed",
        startedAt: null,
        lastAt: "2026-01-01T10:01:00Z",
        toolCalls: 0,
        unreadMail: 0,
        team: null,
        backendType: null,
        filePath: `/fixture/managed/${id}.jsonl`,
        nativeSessionId: native,
        sourceHome: home,
        spawnPrompt: null,
        spawnPromptPreview: null,
        toolUseId: null,
        spawnDepth: 1,
        children: [],
    });
    const codex = worker("codex-name", "codex", "codex-thread-1", "/fixture/codex-home");
    const grok = worker("grok-name", "grok", "grok-session-1", "/fixture/grok-worker-home");
    const sources: WidgetSources = {
        sessions: async () => [],
        decisions: () => [],
        forms: () => [],
        answers: () => [],
        agents: async () => ({
            generatedAt: "",
            orphans: [grok],
            parents: [
                {
                    sessionId: "lead-session",
                    provider: "codex",
                    title: "Lead",
                    project: "Fixture",
                    cwd: "/fixture",
                    filePath: "/fixture/lead.jsonl",
                    model: null,
                    account: null,
                    startedAt: null,
                    lastAt: "2026-01-01T10:00:00Z",
                    live: true,
                    children: [codex],
                },
            ],
        }),
    };
    const snapshot = await widgetSnapshot({ root: await root(), sources });
    const codexRow = snapshot.sessions.find((entry) => entry.agentId === "codex-name")!;
    const grokRow = snapshot.sessions.find((entry) => entry.agentId === "grok-name")!;
    // Delivery looks a worker up by this pair (deliver.ts codexWorkerFor, nativeWorkers), never by its name.
    expect(codexRow.target).toMatchObject({ sessionId: "codex-thread-1", sourceHome: "/fixture/codex-home" });
    expect(grokRow.target).toMatchObject({ sessionId: "grok-session-1", sourceHome: "/fixture/grok-worker-home" });
    expect(await widgetResultNode({ target: codexRow.target, agentId: "codex-name", sources })).toMatchObject({
        id: "codex-name",
    });
});

test("a worker row adopts only the indexed copy of its native session that lives in its own home", async () => {
    const worker: AgentNode = {
        id: "codex-name",
        harness: "codex",
        kind: "worker",
        name: "codex-name",
        description: null,
        agentType: null,
        model: null,
        account: null,
        status: "running",
        startedAt: null,
        lastAt: "2026-01-01T10:01:00Z",
        toolCalls: 0,
        unreadMail: 0,
        team: null,
        backendType: null,
        filePath: "/fixture/managed/codex-name.jsonl",
        nativeSessionId: "shared-thread",
        sourceHome: "/fixture/home-a",
        spawnPrompt: null,
        spawnPromptPreview: null,
        toolUseId: null,
        spawnDepth: 1,
        children: [],
    };
    const indexedIn = (sourceHome: string) => ({
        ...target,
        provider: "codex" as const,
        sessionId: "shared-thread",
        sourceHome,
        title: "Indexed copy",
        project: "Fixture",
        cwdShort: "Fixture",
        mtime: 1,
        model: null,
        account: null,
        filePath: `${sourceHome}/sessions/shared-thread.jsonl`,
    });
    const snapshotWith = async (rows: ReturnType<typeof indexedIn>[]) =>
        widgetSnapshot({
            root: await root(),
            sources: {
                sessions: async () => rows,
                decisions: () => [],
                forms: () => [],
                answers: () => [],
                agents: async () => ({ generatedAt: "", parents: [], orphans: [worker] }),
            },
        });

    // The only indexed copy is in another home: the worker keeps its own target instead of adopting it.
    const foreign = await snapshotWith([indexedIn("/fixture/home-b")]);
    expect(foreign.sessions.find((entry) => entry.agentId === "codex-name")?.target).toMatchObject({
        sessionId: "shared-thread",
        sourceHome: "/fixture/home-a",
    });
    expect(foreign.sessions.filter((entry) => entry.target.sessionId === "shared-thread")).toHaveLength(2);
    const finished = { ...worker, status: "completed" as const };
    const agents = async () => ({ generatedAt: "", parents: [], orphans: [finished] });
    const sessions = async () => [indexedIn("/fixture/home-b")];
    const foreignRow = foreign.sessions.find((entry) => entry.agentId === undefined)!;
    expect(foreignRow.target.sourceHome).toBe("/fixture/home-b");
    expect(
        await widgetResultNode({ target: foreignRow.target, agentId: "codex-name", sources: { agents, sessions } })
    ).toBeUndefined();
    expect(
        await widgetResultNode({
            target: { ...foreignRow.target, sourceHome: "/fixture/home-a" },
            agentId: "codex-name",
            sources: { agents, sessions },
        })
    ).toMatchObject({ id: "codex-name" });

    // The copy in the worker's home (spelled differently) is the worker's own row.
    const own = await snapshotWith([indexedIn("/fixture/home-a/"), indexedIn("/fixture/home-b")]);
    const rows = own.sessions.filter((entry) => entry.target.sessionId === "shared-thread");
    expect(rows).toHaveLength(2);
    expect(rows.find((entry) => entry.agentId === "codex-name")?.title).toBe("codex-name");
    expect(rows.find((entry) => entry.agentId === "codex-name")?.target.sourceHome).toBe("/fixture/home-a/");
});

test("incoming answer, Decision and pending-form writes wake the Widget without its safety poll", async () => {
    const directory = await root();
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: directory }, async () => {
        const controller = new AbortController();
        const answerLog = join(directory, "question", "log");
        const database = join(directory, "question", "qa.db");
        const decisions = join(directory, "question", "decisions", "decisions.jsonl");
        const subscriptions: { directory: string; notify: (path: string) => Promise<void>; closed: boolean }[] = [];
        let emitted = 0;
        let ready!: () => void;
        const started = new Promise<void>((resolve) => {
            ready = resolve;
        });
        const worker = watchWidget({
            root: directory,
            signal: controller.signal,
            emit: () => {
                emitted++;
                ready();
            },
            dependencies: {
                inboxPaths: { answerLog, database, decisions },
                watchInbox: async (directory, callback, options) => {
                    const subscription = {
                        directory,
                        closed: false,
                        notify: async (path: string) => {
                            const event = { path, type: "update" as const };
                            if (options?.filter?.(event) !== false) {
                                await callback([event]);
                            }
                        },
                    };
                    subscriptions.push(subscription);
                    return {
                        active: true,
                        errorCount: 0,
                        unsubscribe: async () => {
                            subscription.closed = true;
                        },
                    };
                },
                snapshot: async () => {
                    return {
                        version: 1,
                        state: await readWidgetState(directory),
                        activity: [],
                        sessions: [],
                        cards: [],
                        manifests: {},
                        changes: null,
                        errors: [],
                        selectedKey: String(emitted),
                    };
                },
                dispatcher: {
                    validate: async () => {},
                    dispatch: async () => ({ delivered: true, channel: "fixture" }),
                },
            },
        });
        try {
            await withTimeout(started, 3000);
            expect(subscriptions).toHaveLength(1);
            expect(subscriptions[0].directory).toBe(join(directory, "question"));
            for (const file of [join(answerLog, "2026-01-01.jsonl"), decisions, `${database}-wal`, database]) {
                const before = emitted;
                await subscriptions[0].notify(file);
                expect(emitted).toBeGreaterThan(before);
            }
            const before = emitted;
            await subscriptions[0].notify(`${database}-shm`);
            await subscriptions[0].notify(join(directory, "question", "unrelated.json"));
            expect(emitted).toBe(before);
        } finally {
            controller.abort();
            await withTimeout(worker, 3000);
        }
        expect(subscriptions.every((subscription) => subscription.closed)).toBe(true);
    });
});

describe("background Widget roster", () => {
    function fixture() {
        let now = 0;
        let changes = 0;
        const workers: Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">[] = [];
        const requests: { id: number }[] = [];
        let terminated = 0;
        const reader = new WidgetRosterReader({
            now: () => now,
            changed: () => {
                changes++;
            },
            createWorker: () => {
                const worker: Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror"> = {
                    onmessage: null,
                    onerror: null,
                    postMessage: (request) => {
                        requests.push(request);
                    },
                    terminate: () => {
                        terminated++;
                    },
                };
                workers.push(worker);
                return worker;
            },
        });
        const reply = (data: WidgetRosterReply, index = workers.length - 1) => {
            workers[index].onmessage?.call(workers[index] as Worker, { data } as MessageEvent<WidgetRosterReply>);
        };
        return {
            reader,
            requests,
            workers,
            reply,
            advance: () => {
                now += 15_001;
            },
            changes: () => changes,
            terminated: () => terminated,
        };
    }

    test("inbox reads stay available while a cold roster is pending and refreshes coalesce", async () => {
        const f = fixture();
        try {
            f.reader.refresh();
            f.reader.refresh();
            f.reader.refresh(true);
            f.reader.refresh(true);
            expect(f.requests).toEqual([{ id: 1 }]);
            const snapshot = await widgetSnapshot({
                root: await root(),
                sources: {
                    sessions: async () => f.reader.rows,
                    agents: async () => f.reader.agents,
                    decisions: () => [],
                    forms: () => [],
                    answers: () => [],
                    rosterStatus: () => ({ loading: f.reader.loading }),
                },
            });
            expect(snapshot.rosterLoading).toBe(true);
            expect(snapshot.errors).toEqual([]);
            expect(f.changes()).toBe(0);
            f.reply({ id: 1, ok: true, rows: [], agents: { generatedAt: "first", parents: [], orphans: [] } });
            expect(f.reader.agents.generatedAt).toBe("first");
            expect(f.requests).toEqual([{ id: 1 }, { id: 2 }]);
            f.reply({ id: 2, ok: true, rows: [], agents: { generatedAt: "second", parents: [], orphans: [] } });
            expect(f.reader.loading).toBe(false);
            expect(f.changes()).toBe(2);
            f.reader.refresh();
            expect(f.requests).toHaveLength(2);
        } finally {
            f.reader.stop();
        }
    });

    test("a failed refresh retains the last tree and restarts only after the refresh interval", () => {
        const f = fixture();
        try {
            f.reader.refresh();
            f.reply({ id: 1, ok: true, rows: [], agents: { generatedAt: "complete", parents: [], orphans: [] } });
            f.advance();
            f.reader.refresh();
            expect(f.workers).toHaveLength(1);
            f.reply({ id: 2, ok: false, error: "index unavailable" });
            expect(f.reader.agents.generatedAt).toBe("complete");
            expect(f.reader.error).toBe("index unavailable");
            expect(f.terminated()).toBe(1);
            f.reader.refresh();
            expect(f.workers).toHaveLength(1);
            f.advance();
            f.reader.refresh();
            expect(f.workers).toHaveLength(2);
            f.reply({ id: 2, ok: true, rows: [], agents: { generatedAt: "late", parents: [], orphans: [] } }, 0);
            expect(f.reader.agents.generatedAt).toBe("complete");
            f.reply({ id: 3, ok: true, rows: [], agents: { generatedAt: "recovered", parents: [], orphans: [] } });
            expect(f.reader.agents.generatedAt).toBe("recovered");
            expect(f.reader.error).toBeUndefined();
        } finally {
            f.reader.stop();
        }
    });

    test("shutdown terminates the thread and rejects late publications", () => {
        const f = fixture();
        f.reader.refresh();
        f.reader.stop();
        f.reply({ id: 1, ok: true, rows: [], agents: { generatedAt: "late", parents: [], orphans: [] } });
        f.reader.refresh(true);
        expect(f.reader.agents.generatedAt).toBe("");
        expect(f.changes()).toBe(0);
        expect(f.requests).toHaveLength(1);
        expect(f.terminated()).toBe(1);
    });

    test("a silent worker has a bounded deadline and an explicit error", async () => {
        let notify!: () => void;
        const changed = new Promise<void>((resolve) => {
            notify = resolve;
        });
        let terminated = 0;
        const reader = new WidgetRosterReader({
            changed: notify,
            timeoutMs: 5,
            createWorker: () => ({
                onmessage: null,
                onerror: null,
                postMessage: () => {},
                terminate: () => {
                    terminated++;
                },
            }),
        });
        try {
            reader.refresh();
            await withTimeout(changed, 1000);
            expect(reader.loading).toBe(false);
            expect(reader.error).toBe("Agent roster refresh timed out");
            expect(terminated).toBe(1);
        } finally {
            reader.stop();
        }
    });

    function scheduled() {
        let now = 0;
        let cpu = 0;
        const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
        const requests: { id: number; index?: string[]; onlyIfChanged?: boolean }[] = [];
        const workers: Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">[] = [];
        let changes = 0;
        const reader = new WidgetRosterReader({
            now: () => now,
            cpuMs: () => cpu,
            changed: () => {
                changes++;
            },
            timer: (run, ms) => {
                const entry = { at: now + ms, run, cancelled: false };
                timers.push(entry);
                return () => {
                    entry.cancelled = true;
                };
            },
            createWorker: () => {
                const worker: Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror"> = {
                    onmessage: null,
                    onerror: null,
                    postMessage: (request) => {
                        requests.push(request);
                    },
                    terminate: () => {},
                };
                workers.push(worker);
                return worker;
            },
        });
        return {
            reader,
            requests,
            changes: () => changes,
            /** Moves the clock and fires every timer that came due. */
            advance: (ms: number) => {
                now += ms;
                for (const entry of timers.filter((timer) => !timer.cancelled && timer.at <= now)) {
                    entry.cancelled = true;
                    entry.run();
                }
            },
            pendingTimers: () => timers.filter((timer) => !timer.cancelled).length,
            spendCpu: (ms: number) => {
                cpu += ms;
            },
            reply: (id: number) => {
                const worker = workers[workers.length - 1];
                const data: WidgetRosterReply = {
                    id,
                    ok: true,
                    rows: [],
                    agents: { generatedAt: `run ${id}`, parents: [], orphans: [] },
                };
                worker.onmessage?.call(worker as Worker, { data } as MessageEvent<WidgetRosterReply>);
            },
            replyUnchanged: (id: number) => {
                const worker = workers[workers.length - 1];
                const data: WidgetRosterReply = { id, ok: true, unchanged: true };
                worker.onmessage?.call(worker as Worker, { data } as MessageEvent<WidgetRosterReply>);
            },
            roster: () => reader.agents.generatedAt,
        };
    }

    test("a refresh that changed no index row keeps the roster and rebuilds nothing; a read request always reads", () => {
        const f = scheduled();
        try {
            f.reader.request(["grok"]);
            f.advance(250);
            expect(f.requests[0]).toEqual({ id: 1, index: ["grok"], onlyIfChanged: true });
            f.reply(1);
            expect(f.changes()).toBe(1);
            f.reader.request(["grok"]);
            f.advance(4000);
            expect(f.requests[1]).toEqual({ id: 2, index: ["grok"], onlyIfChanged: true });
            f.replyUnchanged(2);
            expect(f.changes()).toBe(1);
            expect(f.roster()).toBe("run 1");
            expect(f.reader.loading).toBe(false);
            f.reader.request(["claude"], { read: true });
            f.advance(4000);
            expect(f.requests[2]).toEqual({ id: 3, index: ["claude"] });
        } finally {
            f.reader.stop();
        }
    });

    test("a burst of session changes becomes one run that carries every scope, after a settle delay", () => {
        const f = scheduled();
        try {
            f.reader.request(["claude"]);
            f.reader.request(["codex"]);
            f.reader.request([]);
            expect(f.requests).toEqual([]);
            f.advance(249);
            expect(f.requests).toEqual([]);
            f.advance(1);
            expect(f.requests).toHaveLength(1);
            expect(f.requests[0].index?.sort()).toEqual(["claude", "codex"]);
            expect(f.pendingTimers()).toBe(0);
        } finally {
            f.reader.stop();
        }
    });

    test("changes during a run wait for a pause that grows with the run's cost, then run once", () => {
        const f = scheduled();
        try {
            f.reader.request(["claude"]);
            f.advance(250);
            f.reader.request(["grok"]);
            f.reader.request(["claude-agents"]);
            expect(f.requests).toHaveLength(1);
            // The run took 1 s: the next one waits ten times that from its end, not the 4 s minimum.
            f.advance(1000);
            f.reply(1);
            expect(f.changes()).toBe(1);
            f.advance(9999);
            expect(f.requests).toHaveLength(1);
            f.advance(1);
            expect(f.requests).toHaveLength(2);
            expect(f.requests[1].index?.sort()).toEqual(["claude-agents", "grok"]);
            // A cheap run: the pause is the 4 s floor.
            f.advance(10);
            f.reply(2);
            f.reader.request([]);
            f.advance(3999);
            expect(f.requests).toHaveLength(2);
            f.advance(1);
            expect(f.requests[2]).toEqual({ id: 3 });
            // A quick run that burned 400 ms of CPU: twenty times that, so a busy stream stays under 5% of a core.
            f.spendCpu(400);
            f.advance(50);
            f.reply(3);
            f.reader.request(["claude"]);
            f.advance(7999);
            expect(f.requests).toHaveLength(3);
            f.advance(1);
            expect(f.requests).toHaveLength(4);
        } finally {
            f.reader.stop();
        }
    });

    test("an immediate request skips the pause, a plain refresh defers to a scheduled run, stop cancels it", () => {
        const f = scheduled();
        try {
            f.reader.refresh();
            expect(f.requests).toEqual([{ id: 1 }]);
            f.reader.request(["all"], { immediate: true });
            f.advance(5000);
            f.reply(1);
            f.advance(250);
            expect(f.requests[1]).toEqual({ id: 2, index: ["all"] });
            f.advance(100);
            f.reply(2);
            f.reader.request(["claude"]);
            f.advance(20_000);
            f.reader.refresh();
            expect(f.requests).toHaveLength(3);
            f.advance(100);
            f.reply(3);
            f.reader.request(["codex"]);
            f.reader.refresh();
            expect(f.requests).toHaveLength(3);
            f.reader.stop();
            f.advance(60_000);
            expect(f.requests).toHaveLength(3);
        } finally {
            f.reader.stop();
        }
    });

    test("a changed file names the index scope it can affect; a listed lead's sub-agent asks for a read only", () => {
        const roots = {
            claude: ["/fixture/claude/projects"],
            codex: ["/fixture/codex/sessions"],
            grok: ["/fixture/grok/sessions"],
        };
        const change = (path: string, listed = false) =>
            widgetRosterChange({ path, roots, listedParent: (id) => listed && id === "lead-session" });
        expect(change("/fixture/claude/projects/-fixture-project/lead-session.jsonl")).toBe("claude");
        expect(change("/fixture/claude/projects/-fixture-project/lead-session/subagents/agent-a1.jsonl", true)).toBe(
            "read"
        );
        expect(
            change("/fixture/claude/projects/-fixture-project/lead-session/subagents/agent-a1.meta.json", true)
        ).toBe("read");
        expect(change("/fixture/claude/projects/-fixture-project/old-lead/subagents/agent-a1.jsonl")).toBe(
            "claude-agents"
        );
        expect(change("/fixture/claude/projects/-fixture-project/lead-session/tool-results/out.txt")).toBeUndefined();
        expect(change("/fixture/claude/projects/-fixture-project/memory.md")).toBeUndefined();
        expect(change("/fixture/codex/sessions/2026/10/10/rollout-fixture.jsonl")).toBe("codex");
        expect(change("/fixture/grok/sessions/%2Ffixture/session-1/chat_history.jsonl")).toBe("grok");
        expect(change("/fixture/grok/sessions/%2Ffixture/session-1/chat_history.jsonl.lock")).toBeUndefined();
        expect(change("/fixture/elsewhere/file.jsonl")).toBeUndefined();
    });

    test("session-root events reach the roster as one scoped request; shutdown closes every root watcher", async () => {
        const directory = await root();
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: directory }, async () => {
            const sessionRoots = {
                claude: [join(directory, "claude")],
                codex: [join(directory, "codex")],
                grok: [join(directory, "absent-grok")],
            };
            await mkdir(sessionRoots.claude[0], { recursive: true });
            await mkdir(sessionRoots.codex[0], { recursive: true });
            const watched: {
                directory: string;
                callback: (events: { type: "update"; path: string }[]) => void | Promise<void>;
                closed: boolean;
                filter?: (event: { type: "update"; path: string }) => boolean;
            }[] = [];
            const requests: { scopes: string[]; immediate?: boolean; read?: boolean }[] = [];
            const request = spyOn(WidgetRosterReader.prototype, "request").mockImplementation((scopes, options) => {
                requests.push({ scopes: [...scopes].sort(), immediate: options?.immediate, read: options?.read });
            });
            const refresh = spyOn(WidgetRosterReader.prototype, "refresh").mockImplementation(() => {});
            const controller = new AbortController();
            let ready!: () => void;
            const started = new Promise<void>((resolve) => {
                ready = resolve;
            });
            const worker = watchWidget({
                root: directory,
                signal: controller.signal,
                emit: () => ready(),
                dependencies: {
                    inboxPaths: {
                        answerLog: join(directory, "question/log"),
                        database: join(directory, "question/qa.db"),
                        decisions: join(directory, "question/decisions.jsonl"),
                    },
                    watchInbox: async () => ({ active: true, errorCount: 0, unsubscribe: async () => {} }),
                    sessionRoots,
                    watchSessions: async (path, callback, options) => {
                        const entry = { directory: path, callback, closed: false, filter: options?.filter };
                        watched.push(entry);
                        return {
                            active: true,
                            errorCount: 0,
                            unsubscribe: async () => {
                                entry.closed = true;
                            },
                        };
                    },
                    dispatcher: {
                        validate: async () => {},
                        dispatch: async () => ({ delivered: true, channel: "fixture" }),
                    },
                },
            });
            try {
                await withTimeout(started, 5000);
                expect(watched.map((entry) => entry.directory)).toEqual([
                    sessionRoots.claude[0],
                    sessionRoots.codex[0],
                ]);
                expect(requests).toEqual([{ scopes: ["all"], immediate: true, read: undefined }]);
                const claudeFile = join(sessionRoots.claude[0], "-fixture-project", "fixture-session.jsonl");
                expect(watched[0].filter?.({ type: "update", path: claudeFile })).toBe(true);
                expect(watched[0].filter?.({ type: "update", path: join(sessionRoots.claude[0], "notes.txt") })).toBe(
                    false
                );
                await watched[0].callback([
                    { type: "update", path: claudeFile },
                    { type: "update", path: join(sessionRoots.claude[0], "-fixture-project", "other.jsonl") },
                ]);
                await watched[1].callback([
                    { type: "update", path: join(sessionRoots.codex[0], "2026", "rollout-fixture.jsonl") },
                    { type: "update", path: join(sessionRoots.codex[0], "2026", "notes.jsonl") },
                ]);
                // A sub-agent of a lead the roster does not list needs the sub-agent listing, not just a read.
                await watched[0].callback([
                    {
                        type: "update",
                        path: join(
                            sessionRoots.claude[0],
                            "-fixture-project",
                            "old-lead",
                            "subagents",
                            "agent-a.jsonl"
                        ),
                    },
                ]);
                expect(requests.slice(1)).toEqual([
                    { scopes: ["claude"], immediate: undefined, read: false },
                    { scopes: ["codex"], immediate: undefined, read: false },
                    { scopes: ["claude-agents"], immediate: undefined, read: false },
                ]);
            } finally {
                controller.abort();
                await withTimeout(worker, 5000);
                request.mockRestore();
                refresh.mockRestore();
            }
            expect(watched.every((entry) => entry.closed)).toBe(true);
        });
    });

    test("a seeded roster shows until the first run lands and never replaces a completed one", () => {
        const f = scheduled();
        try {
            const cached = { generatedAt: "cached", parents: [], orphans: [] };
            f.reader.seed({ rows: [], agents: cached });
            expect(f.roster()).toBe("cached");
            expect(f.changes()).toBe(0);
            f.reader.refresh();
            expect(f.requests).toEqual([{ id: 1 }]);
            f.reply(1);
            expect(f.roster()).toBe("run 1");
            f.reader.seed({ rows: [], agents: cached });
            expect(f.roster()).toBe("run 1");
        } finally {
            f.reader.stop();
        }
    });

    async function firstWatchSnapshot(directory: string) {
        const refresh = spyOn(WidgetRosterReader.prototype, "refresh").mockImplementation(() => {});
        const request = spyOn(WidgetRosterReader.prototype, "request").mockImplementation(() => {});
        const controller = new AbortController();
        let first!: (snapshot: Awaited<ReturnType<typeof widgetSnapshot>>) => void;
        const emitted = new Promise<Awaited<ReturnType<typeof widgetSnapshot>>>((resolve) => {
            first = resolve;
        });
        const worker = watchWidget({
            root: directory,
            signal: controller.signal,
            emit: (snapshot) => first(snapshot),
            dependencies: {
                inboxPaths: {
                    answerLog: join(directory, "question/log"),
                    database: join(directory, "question/qa.db"),
                    decisions: join(directory, "question/decisions.jsonl"),
                },
                watchInbox: async () => ({ active: true, errorCount: 0, unsubscribe: async () => {} }),
                sessionRoots: { claude: [], codex: [], grok: [] },
                dispatcher: {
                    validate: async () => {},
                    dispatch: async () => ({ delivered: true, channel: "fixture" }),
                },
            },
        });
        try {
            return await withTimeout(emitted, 5000);
        } finally {
            controller.abort();
            await withTimeout(worker, 5000);
            refresh.mockRestore();
            request.mockRestore();
        }
    }

    test("a new watch's first snapshot shows the previous watch's roster before its own first read", async () => {
        const directory = await root();
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: directory }, async () => {
            const row = {
                provider: "claude" as const,
                sessionId: "fixture-session",
                title: "Invented fixture session",
                cwd: "/fixture/project",
                cwdShort: "/fixture/project",
                project: "fixture",
                mtime: 1_791_000_000_000,
                model: null,
                account: null,
                filePath: "/fixture/project/fixture-session.jsonl",
            };
            const agents = { generatedAt: "previous watch", parents: [], orphans: [] };
            // Written by a watch that has exited: its pid is dead, which a one-shot reader refuses and a new watch accepts.
            await writeWidgetRosterCache({ root: directory, roster: { rows: [row], agents } });
            const cache = join(directory, "roster-cache.json");
            const file = SafeJSON.parse(await readFile(cache, "utf8"), { strict: true });
            await writeFile(cache, SafeJSON.stringify({ ...file, pid: 2_147_483_646 }, { strict: true }));
            const warm = await firstWatchSnapshot(directory);
            expect(warm.rosterLoading).toBe(false);
            expect(warm.sessions.map((session) => session.target.sessionId)).toContain("fixture-session");

            // A day-old cache misleads more than the placeholder: the first snapshot waits for the read.
            await writeWidgetRosterCache({
                root: directory,
                roster: { rows: [row], agents },
                now: Date.now() - 24 * 3_600_000 - 1000,
            });
            const cold = await firstWatchSnapshot(directory);
            expect(cold.rosterLoading).toBe(true);
            expect(cold.sessions.map((session) => session.target.sessionId)).not.toContain("fixture-session");
        });
    });

    test("a one-shot snapshot reads the watch's fresh roster and falls back to the index when it is stale", async () => {
        const directory = await root();
        const agents = { generatedAt: "fixture", parents: [], orphans: [] };
        const rows = [
            {
                provider: "claude" as const,
                sessionId: "fixture-session",
                title: "Invented fixture session",
                cwd: "/fixture/project",
                cwdShort: "/fixture/project",
                project: "fixture",
                mtime: 1_791_000_000_000,
                model: null,
                account: null,
                filePath: "/fixture/project/fixture-session.jsonl",
            },
        ];
        await writeWidgetRosterCache({ root: directory, roster: { rows, agents }, now: 1000 });
        expect(await readWidgetRosterCache({ root: directory, now: 1000 + 90_000, alive: () => true })).toEqual({
            rows,
            agents,
        });
        expect(await readWidgetRosterCache({ root: directory, now: 1000 + 90_001, alive: () => true })).toBeUndefined();
        expect(await readWidgetRosterCache({ root: directory, now: 2000, alive: () => false })).toBeUndefined();
        await writeFile(join(directory, "roster-cache.json"), '{"version":2}');
        expect(await readWidgetRosterCache({ root: directory, now: 2000, alive: () => true })).toBeUndefined();

        // Parity: the cached roster renders exactly what the same roster read from its source renders.
        const base = {
            decisions: () => [],
            forms: () => [],
            answers: () => [],
        };
        const fromCache = await widgetSnapshot({
            root: directory,
            sources: { ...base, sessions: async () => rows, agents: async () => agents },
        });
        await writeWidgetRosterCache({ root: directory, roster: { rows, agents } });
        const cached = await readWidgetRosterCache({ root: directory });
        expect(cached).toEqual({ rows, agents });
        const fromFile = await widgetSnapshot({
            root: directory,
            sources: {
                ...base,
                sessions: async () => cached?.rows ?? [],
                agents: async () => cached?.agents ?? agents,
            },
        });
        expect(SafeJSON.stringify(fromFile, { strict: true })).toBe(SafeJSON.stringify(fromCache, { strict: true }));
        expect(fromFile.sessions.map((session) => session.key)).toHaveLength(1);
    });
});

describe("inbox card images and agent messages", () => {
    const quiet = { sinks: { obsidian: false, sound: false, notify: false } };
    const noAgents = async () => ({ generatedAt: "", parents: [], orphans: [] });

    function png(path: string): string {
        writeFileSync(path, encodeRgbaToPng(new Uint8ClampedArray([30, 60, 90, 255, 200, 120, 40, 255]), 2, 1));
        return path;
    }

    test("markdown images, raw image tokens and bare paths become card attachments; a missing file stays text", async () => {
        const directory = await root();
        const embedded = png(join(directory, "hub after.png"));
        const bare = png(join(directory, "bare.png"));
        const token = png(join(directory, "token.png"));
        const lifted = liftCardImages([
            `Which layout?\n\n![Hub after](${encodeURI(embedded)})`,
            `See ${bare} for the old one.\n\n{{image path="${token}" alt="Token"}}\n\n![Gone](/fixture/missing.png)`,
        ]);

        expect(lifted.texts[0]).toBe("Which layout?");
        expect(lifted.texts[1]).toBe(`See ${bare} for the old one.\n\n![Gone](/fixture/missing.png)`);
        expect(lifted.attachments.map((image) => [image.path, image.label, image.width, image.height])).toEqual([
            [embedded, "Hub after", 2, 1],
            [token, "Token", 2, 1],
            [bare, undefined, 2, 1],
        ]);
        expect(
            lifted.attachments.every((image) => image.mimeType === "image/png" && image.id.startsWith("lifted-"))
        ).toBe(true);
        // Stable ids across refreshes, so the widget does not rebuild the thumbnails every five seconds.
        expect(liftCardImages([`![Hub after](${encodeURI(embedded)})`]).attachments[0]?.id).toBe(
            lifted.attachments[0]?.id
        );
        // A path the card already carries (answer attachments) is not added twice.
        const existing = lifted.attachments[0]!;
        expect(liftCardImages([`![again](${embedded})`], [existing]).attachments).toEqual([existing]);
    });

    test("decision and form cards carry the images of their text as attachments", async () => {
        const directory = await root();
        const shot = png(join(directory, "decision.png"));
        const formShot = png(join(directory, "form.png"));
        const file = join(directory, "decisions.jsonl");
        await postDecisions(
            file,
            join(directory, "events.jsonl"),
            {
                sessionId: target.sessionId,
                provider: "codex",
                decisions: [
                    {
                        title: "Layout",
                        prompt: `Keep the compact layout?\n\n![Compact](${encodeURI(shot)})`,
                        options: ["Keep", "Drop"],
                    },
                ],
            },
            { env: {} }
        );
        const db = openPendingStore(join(directory, "questions.db"));
        try {
            await postAskForm(
                {
                    projectPath: "/fixture/project",
                    sessionHint: target.sessionId,
                    items: [{ id: "colour", promptMarkdown: `Which colour?\n\n![Blue](${formShot})` }],
                },
                { db, eventBase: directory, logBase: directory, notify: false, env: {}, ambient: false }
            );
        } finally {
            db.close();
        }

        const sources: WidgetSources = {
            sessions: async () => [],
            decisions: () => readDecisions(file),
            forms: () => widgetForms({ dbPath: join(directory, "questions.db") }),
            answers: () => [],
            agents: noAgents,
        };
        const snapshot = await widgetSnapshot({ root: directory, sources });
        const decision = snapshot.cards.find((card) => card.kind === "decision");
        const form = snapshot.cards.find((card) => card.kind === "form");

        expect(decision?.title).toBe("Layout");
        expect(decision?.attachments.map((image) => [image.path, image.label])).toEqual([[shot, "Compact"]]);
        expect(form?.attachments.map((image) => [image.path, image.label])).toEqual([[formShot, "Blue"]]);
        expect(form?.formItems?.[0]?.promptMarkdown).toBe("Which colour?");
        expect(form?.title).toBe("Which colour?");
    });

    test("a Codex and a Grok message land as unread message cards under their own sessions, with the screenshot", async () => {
        const directory = await root();
        await env.testing.withOverrides(
            { GENESIS_TOOLS_HOME: directory, QUESTION_LOG_BASE: join(directory, "log") },
            async () => {
                const shot = png(join(directory, "result.png"));
                const harnesses = [
                    { provider: "codex", env: { CODEX_CI: "1", CODEX_THREAD_ID: "codex-thread" }, id: "codex-thread" },
                    { provider: "grok", env: { GROK_SESSION_ID: "grok-session" }, id: "grok-session" },
                ] as const;

                for (const harness of harnesses) {
                    await sendInboxMessage(
                        {
                            text: "Build is green\nAll 40 tests pass.",
                            images: [shot],
                            source: "cli",
                            projectPath: directory,
                        },
                        { env: harness.env, attachmentsRoot: join(directory, "durable"), config: quiet }
                    );
                }

                readQuestionSnapshot({ dbPath: toolDataDir("question", "qa.db"), read: () => undefined });
                const snapshot = await widgetSnapshot({
                    root: directory,
                    sources: {
                        ...realWidgetSources,
                        sessions: async () => [],
                        decisions: () => [],
                        forms: () => [],
                        agents: noAgents,
                    },
                });

                for (const harness of harnesses) {
                    const session = snapshot.sessions.find(
                        (entry) => entry.target.provider === harness.provider && entry.target.sessionId === harness.id
                    );
                    const card = snapshot.cards.find(
                        (entry) => entry.kind === "answer" && entry.sessionKey === session?.key
                    );

                    expect(session).toBeDefined();
                    expect(card).toMatchObject({
                        status: "message",
                        title: "Build is green",
                        body: "All 40 tests pass.",
                        read: false,
                    });
                    expect(card?.attachments).toHaveLength(1);
                    expect(card?.attachments[0]?.path).toStartWith(join(directory, "durable"));
                }

                expect(snapshot.sessions.some((entry) => entry.target.provider === "unknown")).toBe(false);
            }
        );
    });
});

describe("widget agent result", () => {
    test("reads the text of a Claude assistant line and ignores everything else", () => {
        const assistant = {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
        };
        const toolOnly = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } };
        expect(claudeAssistantText(SafeJSON.stringify(assistant))).toBe("Done.");
        expect(claudeAssistantText(SafeJSON.stringify(toolOnly))).toBeUndefined();
        expect(claudeAssistantText(SafeJSON.stringify({ type: "user", message: { content: "hi" } }))).toBeUndefined();
        expect(claudeAssistantText("{not json")).toBeUndefined();
    });

    test("a large transcript yields its last assistant text from the tail, past a long run of tool output", async () => {
        const dir = await mkdtemp(join(tmpdir(), "widget-result-"));
        const file = join(dir, "agent-fixture.jsonl");
        const result = { type: "assistant", message: { content: [{ type: "text", text: "Final highlights." }] } };
        // 1 MB of tool results after the answer would hide it from a 256 KB tail; the window must grow.
        const toolLine = SafeJSON.stringify({
            type: "user",
            message: { content: [{ type: "tool_result", content: "x".repeat(4000) }] },
        });
        const early = { type: "assistant", message: { content: [{ type: "text", text: "An early answer." }] } };
        const lines = [
            SafeJSON.stringify(early),
            SafeJSON.stringify(result),
            ...Array.from({ length: 260 }, () => toolLine),
        ];
        writeFileSync(file, `${lines.join("\n")}\n`);
        const size = (await files.stat(file)).size;
        expect(size).toBeGreaterThan(256 * 1024);
        expect(await lastClaudeAssistantText(file, size)).toBe("Final highlights.");
    });
});
