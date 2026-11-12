import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { readProcessCommand } from "@genesiscz/utils/process-identity";
import { cameraMoviePath } from "@genesiscz/utils/recording-editor/camera";
import { applyOp, readProject, wholeProject, writeProject } from "@genesiscz/utils/recording-editor/project";
import type { RpcProgress } from "@genesiscz/utils/rpc/peer";
import { type RpcNotification, RpcSocketClient, type RpcSocketClientOptions } from "@genesiscz/utils/rpc/socket-client";
import {
    RecorderControl,
    type RecorderMethod,
    type RecorderState,
    type RecorderStatus,
    type RecordingMarker,
    RPC_ERRORS,
    RpcError,
    type StopAnswer,
} from "@genesiscz/utils/screen-recorder/control";
import { recordingsLibraryDir } from "@genesiscz/utils/screen-recorder/library";
import { callRecorder, LiveRecordingServer, RecorderClient } from "@genesiscz/utils/screen-recorder/live";
import * as videoProbe from "@genesiscz/utils/video/probe";
import * as videoProcess from "@genesiscz/utils/video/process";
import { z } from "zod";
import goldenFixture from "./__fixtures__/editor-golden.json";
import screenOpsFixture from "./__fixtures__/screen-hit-ops.json";
import fixture from "./__fixtures__/service-protocol.json";
import schemasFixture from "./__fixtures__/service-protocol.schemas.json";
import * as edits from "./edit";
import { editProject, readUndoSteps, redoEdit, undoEdit } from "./edit";
import { EditSession, EditSessions, type ProjectChanged } from "./edit-session";
import type { HeadlessDeps } from "./host";
import { EDITOR_TABS, editorWindowKeyOf, shortRecordingId } from "./library";
import { chaptersOfPart } from "./moments";
import { applyEdit, callerParams, redoLastEdit, sendOnce, serviceRoutedMovie, undoLastEdit } from "./movie-client";
import { editorGolden, protocolJsonSchemas, screenHitOpsFixture } from "./protocol-fixtures";
import { type RecorderService, type RecorderServiceOptions, startRecorderService } from "./service";
import * as serviceClient from "./service-client";
import { hostCloseEditor, hostStill, ServiceConnectionLost, ServiceHost, withServiceClient } from "./service-client";
import { launchRecorderService } from "./service-launch";
import {
    HOST_METHODS,
    HOST_SCHEMAS,
    hostApi,
    readLiveService,
    recorderServiceDir,
    recordingEventSchema,
    recordingsChangedSchema,
    SERVICE_EVENTS,
    SERVICE_PROTOCOL,
    type ServiceEntry,
    serviceApi,
} from "./service-protocol";
import { Movie, moviesApi, recordingMovie } from "./toolset";

const closing: Array<() => void> = [];

afterEach(() => {
    for (const close of closing.splice(0)) {
        close();
    }
});

/** An edit of a 10 s movie that is never read: the ops used here measure nothing. */
function editFixture(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const path = join(root, "talk.edit.json");
    writeProject(
        path,
        wholeProject({ video: join(root, "talk.mp4"), durationUs: 10_000_000, width: 100, height: 100 })
    );
    return path;
}

/**
 * Holds the next `count` edit computations after they computed, until `release()`: the pause at the await where a
 * save, another writer or a cancel can come between an edit's computation and its change. They still compute.
 */
function holdComputations(count = 1) {
    const real = edits.computeEdit;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let held = 0;
    const spy = spyOn(edits, "computeEdit").mockImplementation(async (args) => {
        const result = await real(args);

        if (held < count) {
            held += 1;

            if (held === count) {
                entered.resolve();
            }

            await resume.promise;
            finished.resolve();
        }

        return result;
    });
    closing.push(() => spy.mockRestore());
    // `finished`: the held computations returned; a timer tick later, whatever their callers do next has run.
    return {
        entered: entered.promise,
        release: () => resume.resolve(),
        settled: async () => {
            await finished.promise;
            await Bun.sleep(1);
        },
    };
}

async function openSession(path: string, saveDelayMs = 10_000) {
    const changes: ProjectChanged[] = [];
    const session = await EditSession.open(path, { onChange: (change) => changes.push(change), saveDelayMs });
    closing.push(() => session.close());
    return { session, changes };
}

describe("an edit session", () => {
    test("changes stay in memory until the debounced save, which writes them and the undo steps at once", async () => {
        const path = editFixture("gt-es-save-");
        const { session, changes } = await openSession(path, 40);
        const first = await session.apply([{ op: "text", from: 1, to: 2, text: "A" }], { by: "agent" });
        await session.apply([{ op: "text", from: 3, to: 4, text: "B" }], { by: "editor" });

        expect(first.revision).toBe(2);
        expect(readProject(path).revision).toBe(1);
        expect(changes).toEqual([
            { path, revision: 2, by: "agent" },
            { path, revision: 3, by: "editor" },
        ]);

        await Bun.sleep(120);
        const saved = readProject(path);
        expect(saved.revision).toBe(3);
        expect(saved.updatedBy).toBe("editor");
        expect(saved.texts?.map((text) => text.text)).toEqual(["A", "B"]);
        expect(readUndoSteps(path).map((step) => step.afterRevision)).toEqual([2, 3]);

        // The CLI's undo, after the session, reads the same history.
        session.close();
        expect((await undoEdit(path)).project.texts?.map((text) => text.text)).toEqual(["A"]);
    });

    test("undo and redo step through the session's history; a new change ends the redo", async () => {
        const path = editFixture("gt-es-undo-");
        const { session } = await openSession(path);
        await session.apply([{ op: "text", from: 1, to: 2, text: "A" }], { by: "agent" });
        await session.apply([{ op: "text", from: 3, to: 4, text: "B" }], { by: "agent" });

        const undone = await session.undo({ by: "editor" });
        expect(undone.undone).toEqual(["text"]);
        expect(undone.project.texts?.map((text) => text.text)).toEqual(["A"]);
        expect((await session.redo({ by: "editor" })).project.texts?.map((text) => text.text)).toEqual(["A", "B"]);
        await session.undo({ by: "editor" });
        await session.apply([{ op: "volume", volume: 0.5 }], { by: "agent" });
        await expect(session.redo({ by: "editor" })).rejects.toMatchObject({ code: RPC_ERRORS.nothingToRedo });
        expect(session.current.revision).toBe(7);
        await expect(
            session.apply([{ op: "volume", volume: 0.4 }], { by: "editor", baseRevision: 6 })
        ).rejects.toMatchObject({ code: RPC_ERRORS.staleRevision });
    });

    test("a save after another writer's save keeps both edits, and refuses with staleRevision when they clash", async () => {
        const path = editFixture("gt-es-stale-");
        const { session } = await openSession(path);
        await session.apply([{ op: "text", from: 1, to: 2, text: "mine" }], { by: "agent" });
        const disk = readProject(path);
        writeProject(path, { ...disk, audio: { ...disk.audio, volume: 0.3 } }, "editor");
        session.flush();

        const both = readProject(path);
        expect(both.texts?.map((text) => text.text)).toEqual(["mine"]);
        expect(both.audio.volume).toBe(0.3);

        const zoomed = await session.apply([{ op: "zoom", from: 1, to: 3 }], { by: "agent" });
        session.flush();
        const id = zoomed.project.zooms[0].id;
        await session.apply([{ op: "unzoom", id }], { by: "agent" });
        const before = readProject(path);
        writeProject(path, { ...before, zooms: [] }, "editor");

        expect(() => session.flush()).toThrow(/editor saved the edit/);
        expect(session.current.project.zooms).toEqual([]);
        expect(session.current.revision).toBe(readProject(path).revision);
    });

    // Regression test: 2026-11-05 recorder service review, finding 3 — a window save at the session's revision was overwritten
    test("a window save that reuses the session's revision is taken in, not overwritten", async () => {
        const path = editFixture("gt-es-same-rev-");
        const windowCopy = readProject(path);
        const { session } = await openSession(path);
        await session.apply([{ op: "text", from: 1, to: 2, text: "service" }], { by: "agent" });
        session.flush();
        // The window saves from the copy it loaded before, and gives its file the revision the session just wrote.
        writeProject(path, { ...windowCopy, audio: { ...windowCopy.audio, volume: 0.3 } }, "editor");
        expect(readProject(path).revision).toBe(2);

        await session.apply([{ op: "marker", at: 2, label: "next" }], { by: "agent" });
        session.flush();
        const saved = readProject(path);
        expect({ volume: saved.audio.volume, markers: saved.markers?.map((marker) => marker.label) }).toEqual({
            volume: 0.3,
            markers: ["next"],
        });
    });

    // Regression test: 2026-11-05 recorder service review, finding 2 — a save while an edit computed lost a rebased change
    test("a save while an edit computes keeps the other writer's change that the save took in", async () => {
        const path = editFixture("gt-es-flush-compute-");
        const { session } = await openSession(path);
        await session.apply([{ op: "text", from: 1, to: 2, text: "A" }], { by: "editor" });
        const held = holdComputations();
        const applying = session.apply([{ op: "marker", at: 3, label: "B" }], { by: "agent" });
        await held.entered;

        const disk = readProject(path);
        writeProject(path, { ...disk, audio: { ...disk.audio, volume: 0.3 } }, "editor");
        session.flush();
        held.release();
        await applying;
        session.flush();

        const saved = readProject(path);
        expect({
            volume: saved.audio.volume,
            texts: saved.texts?.map((text) => text.text),
            markers: saved.markers?.map((marker) => marker.label),
        }).toEqual({ volume: 0.3, texts: ["A"], markers: ["B"] });
    });

    // Regression test: 2026-11-05 recorder service review, finding 8 — a closed session still made an edit it had accepted
    test("an edit the session accepted before its close is refused, and the closed session stays as it was", async () => {
        const path = editFixture("gt-es-closed-work-");
        const { session } = await openSession(path);
        const applying = session.apply([{ op: "volume", volume: 0.2 }], { by: "agent" });
        session.close();

        await expect(applying).rejects.toThrow(/closed/);
        expect({ dirty: session.dirty, volume: session.current.project.audio.volume }).toEqual({
            dirty: false,
            volume: 1,
        });
    });

    // Regression test: 2026-11-05 recorder service review, finding 8 — an edit computing at the close still changed the session
    test("an edit that is still computing when the session closes is refused when it finishes", async () => {
        const path = editFixture("gt-es-closed-computing-");
        const { session } = await openSession(path);
        const held = holdComputations();
        const applying = session.apply([{ op: "volume", volume: 0.2 }], { by: "agent" });
        await held.entered;
        session.close();
        held.release();

        await expect(applying).rejects.toThrow(/closed/);
        expect({ dirty: session.dirty, volume: session.current.project.audio.volume }).toEqual({
            dirty: false,
            volume: 1,
        });
    });

    test("a drag previews without saving, commits as one undo step, and a newer preview replaces the waiting one", async () => {
        const path = editFixture("gt-es-drag-");
        const { session, changes } = await openSession(path);
        const { project } = await session.apply([{ op: "zoom", from: 1, to: 3 }], { by: "agent" });
        const id = project.zooms[0].id;
        session.beginGesture("drag-1");

        const first = session.previewGesture("drag-1", [{ op: "retime", id, at: 2 }]);
        const replaced = session.previewGesture("drag-1", [{ op: "retime", id, at: 3 }]);
        const last = session.previewGesture("drag-1", [{ op: "retime", id, at: 4 }]);

        expect((await first).project.zooms[0].startUs).toBe(2_000_000);
        expect(await replaced).toMatchObject({ superseded: true });
        expect((await last).project.zooms[0].startUs).toBe(4_000_000);
        expect(session.current.project.zooms[0].startUs).toBe(1_000_000);
        expect(changes).toHaveLength(1);

        const committed = await session.commitGesture("drag-1", { by: "editor" });
        expect(committed.project.zooms[0].startUs).toBe(4_000_000);
        expect(session.undoDepth).toBe(2);

        session.beginGesture("drag-2");
        await session.previewGesture("drag-2", [{ op: "retime", id, at: 6 }]);
        expect(session.cancelGesture("drag-2").project.zooms[0].startUs).toBe(4_000_000);
        expect((await session.undo({ by: "editor" })).project.zooms[0].startUs).toBe(1_000_000);
    });

    test("the sessions of the service: one per edit file, held per opener, saved by the last release", async () => {
        const path = editFixture("gt-es-hold-");
        const sessions = new EditSessions({ onChange: () => undefined, saveDelayMs: 10_000 });
        const [a, b] = await Promise.all([sessions.hold(path), sessions.hold(path)]);
        expect(a).toBe(b);
        await a.apply([{ op: "volume", volume: 0.7 }], { by: "agent" });
        sessions.release(path);
        expect(sessions.size).toBe(1);
        expect(readProject(path).audio.volume).toBe(1);
        sessions.release(path);
        expect(sessions.size).toBe(0);
        expect(readProject(path).audio.volume).toBe(0.7);
    });
});

/** A service on a scratch folder whose face and `open` are stubs: no app starts. */
async function serviceFixture(options: Partial<RecorderServiceOptions> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "rs-"));
    const opened: string[][] = [];
    const faceRuns: string[][] = [];
    const headless: Partial<HeadlessDeps> = {
        runFace: async (argv) => {
            faceRuns.push(argv);
            return {
                code: 0,
                stdout: `{"ok":true,"path":"/tmp/headless-still.png","width":640,"height":360}\n`,
                stderr: "",
            };
        },
        open: (args) => opened.push(args),
        editorState: () => null,
        ...options.headless,
    };
    const start = await startRecorderService({ dir, idleMs: 0, hostWaitMs: 60, ...options, headless });

    if (start.status !== "started") {
        throw new Error("the fixture service did not start");
    }

    closing.push(() => start.service.stop("test"));
    return { dir, service: start.service, opened, faceRuns };
}

async function connect(entry: ServiceEntry, onRequest?: RpcSocketClientOptions["onRequest"]) {
    const client = await RpcSocketClient.connect({
        socket: entry.socket,
        logScope: "recorder-service-test",
        label: "recorder service",
        ...(onRequest ? { onRequest } : {}),
    });
    closing.push(() => client.close());
    return client;
}

function hello(role: "host" | "client" | "recording", answers?: string[]) {
    return { role, protocol: SERVICE_PROTOCOL, pid: process.pid, ...(answers ? { answers } : {}) };
}

describe("one undo and redo journal for the session and the file", () => {
    test("ops that change nothing say so and make no undo step", async () => {
        const { session } = await openSession(editFixture("gt-es-noop-"));
        const first = await session.apply([{ op: "volume", volume: 0.5 }], { by: "agent" });
        expect(first.changed).toBeUndefined();
        const depth = session.undoDepth;
        const again = await session.apply([{ op: "volume", volume: 0.5 }], { by: "agent" });
        expect(again.changed).toBe(false);
        expect(session.undoDepth).toBe(depth);

        session.beginGesture("g");
        const empty = await session.commitGesture("g", { by: "editor" });
        expect(empty.changed).toBe(false);
    });

    test("a session takes the file's redo when the undo was the file's last change", async () => {
        const path = editFixture("gt-es-redo-in-");
        await editProject(path, [{ op: "volume", volume: 0.4 }]);
        await undoEdit(path);
        const { session } = await openSession(path);
        expect(session.redoDepth).toBe(1);
        const redone = await session.redo({ by: "editor" });
        expect(redone.redone).toEqual(["volume"]);
        expect(redone.project.audio.volume).toBe(0.4);
    });

    test("an undo in the session can be redone from the file after the session closes", async () => {
        const path = editFixture("gt-es-redo-out-");
        const { session } = await openSession(path);
        await session.apply([{ op: "volume", volume: 0.4 }], { by: "agent" });
        await session.undo({ by: "agent" });
        session.close();
        const redone = await redoEdit(path);
        expect(redone.redone).toEqual(["volume"]);
        expect(redone.project.audio.volume).toBe(0.4);
    });
});

describe("the recorder service", () => {
    test("hello names the methods, refuses another protocol (1011) and a second host (1012); a second start finds the first", async () => {
        const { dir, service } = await serviceFixture();
        expect(readLiveService(dir)?.socket).toBe(service.entry.socket);

        const second = await startRecorderService({ dir, idleMs: 0 });
        expect(second.status).toBe("running");

        const client = await connect(service.entry);
        const answer = await client.call<{ protocol: number; methods: string[]; version: string }>(
            "hello",
            hello("client")
        );
        expect(answer.protocol).toBe(SERVICE_PROTOCOL);
        expect(answer.methods).toEqual(
            expect.arrayContaining([
                "edit.apply",
                "gesture.preview",
                "subscribe",
                "render.still",
                "camera.start",
                "movie.split",
                "movie.marker",
                "movie.unmarker",
                "movies.search",
            ])
        );
        await expect(client.call<unknown>("hello", { ...hello("client"), protocol: 2 })).rejects.toMatchObject({
            code: RPC_ERRORS.protocolMismatch,
        });

        const host = await connect(service.entry);
        await host.call<unknown>("hello", hello("host"));
        const rival = await connect(service.entry);
        await expect(rival.call<unknown>("hello", hello("host"))).rejects.toMatchObject({ code: RPC_ERRORS.hostTaken });

        // A host whose connection went may be replaced.
        host.close();
        await Bun.sleep(20);
        await rival.call<unknown>("hello", hello("host"));
    });

    test("a client's edit is saved at once and every subscriber hears project.changed; the window's waits for its save", async () => {
        const { service } = await serviceFixture({ saveDelayMs: 10_000 });
        const path = editFixture("rs-edit-");
        const watcher = await connect(service.entry);
        const heard: RpcNotification[] = [];
        watcher.onNotification((notification) => heard.push(notification));
        await watcher.call<unknown>("subscribe", { events: ["project.changed"] });

        const window = await connect(service.entry);
        await window.call<unknown>("hello", hello("host"));
        await window.call<unknown>("session.open", { path });
        await window.call<unknown>("edit.apply", { path, ops: [{ op: "volume", volume: 0.5 }], baseRevision: 1 });
        expect(readProject(path).audio.volume).toBe(1);

        const agent = await connect(service.entry);
        await agent.call<unknown>("hello", hello("client"));
        const applied = await agent.call<{ revision: number }>("edit.apply", {
            path,
            ops: [{ op: "text", from: 1, to: 2, text: "agent" }],
        });
        const saved = readProject(path);
        expect(saved.revision).toBe(applied.revision);
        expect(saved.audio.volume).toBe(0.5);
        expect(saved.texts?.map((text) => text.text)).toEqual(["agent"]);

        await expect(
            window.call<unknown>("edit.apply", { path, ops: [{ op: "volume", volume: 0.2 }], baseRevision: 1 })
        ).rejects.toMatchObject({ code: RPC_ERRORS.staleRevision });
        await agent.call<unknown>("edit.undo", { path });
        await agent.call<unknown>("edit.redo", { path });
        await Bun.sleep(10);
        expect(
            heard.map((notification) => [notification.method, Reflect.get(Object(notification.params), "by")])
        ).toEqual([
            ["project.changed", "editor"],
            ["project.changed", "agent"],
            ["project.changed", "agent"],
            ["project.changed", "agent"],
        ]);

        // The window's connection ends: its session saves and closes.
        window.close();
        await Bun.sleep(20);
        expect(service.sessions.size).toBe(0);
    });

    // Regression test: deep test 2026-11-06 RE4 — a reopened window could not tell that the service kept undo steps.
    test("session.open says how many undo steps the edit keeps, after a close and a reopen too", async () => {
        const { service } = await serviceFixture({ saveDelayMs: 0 });
        const path = editFixture("rs-undo-depth-");
        const window = await connect(service.entry);
        await window.call<unknown>("hello", hello("host"));
        expect(await window.call<{ undoDepth?: number }>("session.open", { path })).toMatchObject({ undoDepth: 0 });
        await window.call<unknown>("edit.apply", { path, ops: [{ op: "volume", volume: 0.5 }] });
        await window.call<unknown>("session.close", { path });
        await Bun.sleep(20);

        expect(await window.call<{ undoDepth?: number }>("session.open", { path })).toMatchObject({ undoDepth: 1 });
    });

    // Regression test: deep test 2026-11-06 RE10 — an undo from outside reached the window as a plain edit.
    test("project.changed says when a change is an undo or a redo, with a session or without one", async () => {
        const { service } = await serviceFixture({ saveDelayMs: 10_000 });
        const held = editFixture("rs-action-held-");
        const loose = editFixture("rs-action-loose-");
        const watcher = await connect(service.entry);
        const heard: RpcNotification[] = [];
        watcher.onNotification((notification) => heard.push(notification));
        await watcher.call<unknown>("subscribe", { events: ["project.changed"] });
        const agent = await connect(service.entry);
        await agent.call<unknown>("hello", hello("client"));
        await agent.call<unknown>("session.open", { path: held });
        await agent.call<unknown>("edit.apply", { path: held, ops: [{ op: "volume", volume: 0.4 }] });
        await agent.call<unknown>("edit.undo", { path: held });
        await agent.call<unknown>("edit.redo", { path: held });
        await agent.call<unknown>("edit.apply", { path: loose, ops: [{ op: "volume", volume: 0.4 }] });
        await agent.call<unknown>("edit.undo", { path: loose });
        await waitUntil("every project.changed", () => heard.length === 5, 1_000);

        expect(heard.map((notification) => Reflect.get(Object(notification.params), "action"))).toEqual([
            undefined,
            "undo",
            "redo",
            undefined,
            "undo",
        ]);
    });

    // Regression test: deep test 2026-11-06 RE1 — a second editor window's close ended the first window's session.
    test("two windows on one connection hold a session apart, so one window's close leaves the other's", async () => {
        const { service } = await serviceFixture({ saveDelayMs: 10_000 });
        const path = editFixture("rs-two-windows-");
        const app = await connect(service.entry);
        await app.call<unknown>("hello", hello("host"));
        await app.call<unknown>("session.open", { path, holder: "window-1" });
        await app.call<unknown>("session.open", { path, holder: "window-2" });
        // A window reads the edit again with session.open; that is no second hold.
        await app.call<unknown>("session.open", { path, holder: "window-1" });

        await app.call<unknown>("session.close", { path, holder: "window-2" });
        await Bun.sleep(20);
        expect(service.sessions.size).toBe(1);

        await app.call<unknown>("session.close", { path, holder: "window-1" });
        await Bun.sleep(20);
        expect(service.sessions.size).toBe(0);
    });

    // Regression test: hunt 2026-11-09 r2-editor-follows-moved-recording: a trashed recording's window made its folder again
    test("a recording moved away while a window edits it: its save makes no folder again, edits are refused and the close releases the hold", async () => {
        const { service } = await serviceFixture({ saveDelayMs: 50 });
        const path = editFixture("rs-moved-away-");
        const app = await connect(service.entry);
        await app.call<unknown>("hello", hello("host"));
        const opened = await app.call<{ path: string }>("session.open", { path, holder: "window-1" });
        await app.call<unknown>("edit.apply", { path: opened.path, ops: [{ op: "volume", volume: 0.4 }] });
        renameSync(dirname(opened.path), `${dirname(opened.path)}-trashed`);
        await Bun.sleep(250);

        expect(existsSync(dirname(opened.path))).toBe(false);
        await expect(
            app.call<unknown>("edit.apply", { path: opened.path, ops: [{ op: "volume", volume: 0.5 }] })
        ).rejects.toThrow("the recording was moved or trashed; close this window");
        expect(await app.call<unknown>("session.close", { path: opened.path, holder: "window-1" })).toEqual({
            closed: true,
        });
        await Bun.sleep(20);
        expect(service.sessions.size).toBe(0);
        expect(existsSync(dirname(opened.path))).toBe(false);
    });

    // Regression test: 2026-11-05 recorder service review, finding 12 — a service edit without an open session told nobody
    test("an edit and an undo through the service without an open session tell every subscriber; no change tells none", async () => {
        const { service } = await serviceFixture();
        const path = editFixture("rs-no-session-event-");
        const watcher = await connect(service.entry);
        const heard: RpcNotification[] = [];
        watcher.onNotification((notification) => heard.push(notification));
        await watcher.call<unknown>("subscribe", { events: ["project.changed"] });
        const agent = await connect(service.entry);
        await agent.call<unknown>("hello", hello("client"));

        await agent.call<unknown>("edit.apply", { path, ops: [{ op: "volume", volume: 0.4 }] });
        await agent.call<unknown>("edit.apply", { path, ops: [{ op: "volume", volume: 0.4 }] });
        await agent.call<unknown>("edit.undo", { path });
        const revisionOf = (notification: RpcNotification) => Reflect.get(Object(notification.params), "revision");
        await waitUntil(
            "the undo's project.changed",
            () => heard.some((notification) => revisionOf(notification) === 3),
            1_000
        );

        expect(heard.map((notification) => [notification.method, revisionOf(notification)])).toEqual([
            ["project.changed", 2],
            ["project.changed", 3],
        ]);
    });

    // Regression test: 2026-11-05 recorder service review, finding 6 — a second client's gesture took over the first's
    test("two clients' gestures with the same id stay apart, so each commit makes its own client's draft", async () => {
        const { service } = await serviceFixture({ saveDelayMs: 10_000 });
        const path = editFixture("rs-gesture-owner-");
        const a = await connect(service.entry);
        const b = await connect(service.entry);
        await a.call<unknown>("session.open", { path });
        await b.call<unknown>("session.open", { path });

        await a.call<unknown>("gesture.begin", { path, gesture: "drag-1" });
        await a.call<unknown>("gesture.preview", { path, gesture: "drag-1", ops: [{ op: "volume", volume: 0.2 }] });
        await b.call<unknown>("gesture.begin", { path, gesture: "drag-1" });
        await b.call<unknown>("gesture.preview", { path, gesture: "drag-1", ops: [{ op: "volume", volume: 0.8 }] });
        const committed = await a.call<{ project: { audio: { volume: number } } }>("gesture.commit", {
            path,
            gesture: "drag-1",
        });

        expect(committed.project.audio.volume).toBe(0.2);
    });

    // Regression test: 2026-11-05 recorder service review, finding 7 — a client gone during session.open left a session
    test("a client that goes while its session.open runs leaves no session open", async () => {
        const { service } = await serviceFixture();
        const path = editFixture("rs-open-gone-");
        const client = await connect(service.entry);
        const real = EditSession.open;
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const opened = Promise.withResolvers<void>();
        const spy = spyOn(EditSession, "open").mockImplementation(async (value, options) => {
            entered.resolve();
            await resume.promise;
            const session = await real.call(EditSession, value, options);
            opened.resolve();
            return session;
        });
        closing.push(() => spy.mockRestore());

        const opening = client.call<unknown>("session.open", { path }).catch((error: unknown) => error);
        await entered.promise;
        client.close();
        // The service hears the close on its side of the socket; the open goes on after it.
        await Bun.sleep(30);
        resume.resolve();
        await opened.promise;
        await opening;
        await Bun.sleep(1);

        expect(service.sessions.size).toBe(0);
    });

    test("a host method reaches the connected host and its answer, progress and cancel go both ways", async () => {
        const { service, faceRuns } = await serviceFixture({ saveDelayMs: 10_000 });
        const path = editFixture("rs-host-");
        const seen: Array<{ method: string; revision: number }> = [];
        let exportAborted = false;
        const host = await connect(service.entry, async ({ method, params }, context) => {
            seen.push({ method, revision: readProject(path).revision });

            if (method === "render.export") {
                context.progress({ fraction: 0.5, label: "export" });
                await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
                exportAborted = true;
                return { ok: true, path: "/tmp/never.mp4", bytes: 1, seconds: 1 };
            }

            return {
                ok: true,
                path: "/tmp/fixture-still.png",
                width: 1920,
                height: 1080,
                atSeconds: Reflect.get(Object(params), "atSeconds"),
            };
        });
        await host.call<unknown>("hello", hello("host", ["render.still", "render.export"]));

        // The window's unsaved change reaches the file before the host renders it.
        const window = await connect(service.entry);
        await window.call<unknown>("session.open", { path });
        await window.call<unknown>("hello", hello("client"));
        const owner = service.sessions.get(path);
        await owner?.apply([{ op: "volume", volume: 0.3 }], { by: "editor" });

        const repl = await connect(service.entry);
        expect(await repl.call<unknown>("render.still", { path, atSeconds: 2 })).toEqual({
            ok: true,
            path: "/tmp/fixture-still.png",
            width: 1920,
            height: 1080,
            atSeconds: 2,
        });
        expect(seen).toEqual([{ method: "render.still", revision: 2 }]);
        expect(faceRuns).toEqual([]);

        const updates: RpcProgress[] = [];
        const controller = new AbortController();
        const exporting = repl.call(
            "render.export",
            { path },
            {
                signal: controller.signal,
                onProgress: (update) => {
                    updates.push(update);
                    controller.abort();
                },
            }
        );
        await expect(exporting).rejects.toMatchObject({ code: RPC_ERRORS.cancelled });
        await Bun.sleep(20);
        expect(updates).toEqual([{ fraction: 0.5, label: "export" }]);
        expect(exportAborted).toBe(true);
    });

    test("without a host, renders run the headless face, windows open through the app's arguments, and the camera says why not", async () => {
        const { service, faceRuns, opened } = await serviceFixture({
            headless: {
                editorState: () => ({
                    version: 1,
                    updatedAt: "",
                    open: [{ path: "/rec/talk", title: "Talk", window: 7 }],
                }),
            },
        });
        const client = await connect(service.entry);

        expect(
            await client.call<unknown>("render.still", {
                path: "/rec/talk/screen.edit.json",
                atSeconds: 1,
                out: "/tmp/s.png",
            })
        ).toEqual({
            ok: true,
            path: "/tmp/headless-still.png",
            width: 640,
            height: 360,
        });
        expect(faceRuns[0]).toEqual([
            "--recorder",
            "--still",
            "/rec/talk/screen.edit.json",
            "--at",
            "1",
            "--out",
            "/tmp/s.png",
        ]);
        expect(await client.call<unknown>("window.open", { path: "/rec/talk/edit.json", focus: false })).toEqual({
            opened: true,
            window: 7,
        });
        expect(opened[0]).toEqual(
            expect.arrayContaining(["--recorder", "--edit", "/rec/talk/edit.json", "--no-focus"])
        );
        expect(await client.call<unknown>("window.list", {})).toEqual({
            open: [{ path: "/rec/talk", title: "Talk", window: 7 }],
        });
        await expect(client.call<unknown>("camera.start", { folder: "/rec/talk" })).rejects.toMatchObject({
            code: RPC_ERRORS.hostUnavailable,
        });
        expect(opened.at(-1)).toEqual(expect.arrayContaining(["-g", "--args", "--recorder"]));
        await expect(client.call<unknown>("render.snapshot", { out: "/tmp/x.png" })).rejects.toMatchObject({
            code: RPC_ERRORS.invalidParams,
        });
    });

    // Regression test: 2026-11-05 recorder service review, finding 10 — the camera's launch reused a running app face
    test("without a host, a camera call asks open for a new app process, whose main gets --recorder", async () => {
        const { service, opened } = await serviceFixture();
        const client = await connect(service.entry);
        await expect(client.call<unknown>("camera.start", { folder: "/rec/talk" })).rejects.toMatchObject({
            code: RPC_ERRORS.hostUnavailable,
        });

        const launch = opened.at(-1) ?? [];
        expect(launch.slice(0, launch.indexOf("--args"))).toContain("-n");
    });

    test("it exits when idle, and when a loaded module of its source changed since its start", async () => {
        const idle = await serviceFixture({ idleMs: 30, checkEveryMs: 15 });
        expect(await Promise.race([idle.service.stopped, Bun.sleep(1_000).then(() => "still running")])).toBe("idle");
        expect(readLiveService(idle.dir)).toBeUndefined();

        // The module cache names real paths, and the temporary folder is a symlink on macOS.
        const source = realpathSync(mkdtempSync(join(tmpdir(), "rs-src-")));
        const module = join(source, "loaded.ts");
        writeFileSync(module, "export const loaded = true;\n");
        await import(module);
        const changing = await serviceFixture({ sourceRoot: source, checkEveryMs: 15 });
        const later = new Date(Date.now() + 60_000);
        utimesSync(module, later, later);
        expect(await Promise.race([changing.service.stopped, Bun.sleep(1_000).then(() => "still running")])).toBe(
            "code-changed"
        );
    });
});

describe("finishing an export", () => {
    // Regression test: deep test 2026-11-06 RC16 — `tools recorder finish` with a movie that does not exist exited 0.
    test("refuses a movie that does not exist, and says so", async () => {
        const path = editFixture("rs-finish-");
        const movie = join(path.slice(0, path.lastIndexOf("/")), "never-exported.mp4");

        await expect(edits.finishExport({ value: path, answer: { ok: true, path: movie } })).rejects.toThrow(
            `${movie} does not exist`
        );
    });

    // Round 2 hunt (r2-intermediate-format-settings): the Export tab hides the subtitle file for a GIF, so the edit's
    // export.subtitles default writes none beside a GIF; an explicit ask still does.
    test("a GIF gets no subtitle file from the edit's default, an MP4 does, and an explicit ask writes one", async () => {
        const root = mkdtempSync(join(tmpdir(), "rs-finish-gif-"));
        const path = join(root, "clip.edit.json");
        const base = wholeProject({ video: join(root, "clip.mp4"), durationUs: 4_000_000, width: 100, height: 100 });
        writeProject(path, { ...base, export: { ...base.export, subtitles: "srt", chapters: false } });
        writeFileSync(join(root, "clip.transcript.json"), '{"segments":[{"start":0.5,"end":1.5,"text":"Hello"}]}');
        const gif = join(root, "clip.gif");
        const mp4 = join(root, "out.mp4");
        writeFileSync(gif, "movie");
        writeFileSync(mp4, "movie");

        const fromGif = await edits.finishExport({ value: path, answer: { ok: true, path: gif } });
        expect(fromGif.subtitles).toBeUndefined();
        expect(existsSync(join(root, "clip.srt"))).toBe(false);

        const fromMp4 = await edits.finishExport({ value: path, answer: { ok: true, path: mp4 } });
        expect(fromMp4.subtitles).toBe(join(root, "out.srt"));

        const asked = await edits.finishExport({ value: path, answer: { ok: true, path: gif }, subtitles: "vtt" });
        expect(asked.subtitles).toBe(join(root, "clip.vtt"));
    });
});

describe("finishing a part export of an edit with cards", () => {
    /** A 10 s edit with a 3 s intro and end card, one transcript line at source 2.5 s and markers at 3 s and 4.5 s. */
    function cardedEdit(prefix: string): { path: string; root: string } {
        const root = mkdtempSync(join(tmpdir(), prefix));
        const path = join(root, "talk.edit.json");
        writeProject(path, {
            ...wholeProject({ video: join(root, "talk.mp4"), durationUs: 10_000_000, width: 100, height: 100 }),
            cards: { intro: { title: "Demo", seconds: 3 }, end: { text: "Bye", qr: false, seconds: 3 } },
            markers: [
                { id: "m1", atUs: 3_000_000, label: "Step one" },
                { id: "m2", atUs: 4_500_000, label: "Step two" },
            ],
        });
        writeFileSync(
            join(root, "talk.transcript.json"),
            '{"segments":[{"start":2.5,"end":3.5,"text":"Hello there"}]}'
        );
        return { path, root };
    }

    // Round 1 hunt (part-export-cards): a part plays no cards on any route, so its cues start from the part, while the
    // window's `recorder finish --from --to` moved them by the whole edit's intro.
    test("a part's subtitles start from the part, not after the intro; a whole export still moves them by it", async () => {
        const { path, root } = cardedEdit("rs-finish-part-");
        const movie = join(root, "part.webm");
        writeFileSync(movie, "movie");

        const part = await edits.finishExport({
            value: path,
            answer: { ok: true, path: movie },
            subtitles: "srt",
            part: { fromUs: 2_000_000, toUs: 5_000_000 },
        });
        expect(part.subtitles).toBe(join(root, "part.srt"));
        expect(readFileSync(join(root, "part.srt"), "utf8")).toContain("00:00:00,500 --> 00:00:01,500");

        await edits.finishExport({ value: path, answer: { ok: true, path: movie }, subtitles: "srt" });
        expect(readFileSync(join(root, "part.srt"), "utf8")).toContain("00:00:05,500 --> 00:00:06,500");
    });

    test("a part's chapters have no intro chapter and start from the part", async () => {
        const { path, root } = cardedEdit("rs-finish-chapters-");
        const movie = join(root, "part.mp4");
        writeFileSync(movie, "movie");
        const written: string[] = [];
        const probe = spyOn(videoProbe, "probeVideo").mockImplementation(async ({ input }) => ({
            path: input,
            durationUs: 3_000_000,
            width: 100,
            height: 100,
            displayWidth: 100,
            displayHeight: 100,
            rotation: 0,
            bytes: 5,
            codec: "h264",
        }));
        const ffmpeg = spyOn(videoProcess, "runVideoCommand").mockImplementation(async ({ command }) => {
            written.push(readFileSync(command[command.indexOf("ffmetadata") + 2] ?? "", "utf8"));
            writeFileSync(command.at(-1) ?? "", "movie");
            return "";
        });
        closing.push(
            () => probe.mockRestore(),
            () => ffmpeg.mockRestore()
        );

        const answer = await edits.finishExport({
            value: path,
            answer: { ok: true, path: movie },
            part: { fromUs: 2_000_000, toUs: 5_000_000 },
        });

        // The part starts in the 0:00 chapter chapterPoints adds before the first marker; no chapter names the intro card.
        expect(answer.chapters).toBe(3);
        expect(written[0]).not.toContain("title=Demo");
        expect(written[0]).toContain("START=1000\nEND=2500\ntitle=Step one");
    });

    // Round 1 hunt (intro-card-export-clock): subtitles() and `tools recorder subtitles` write the file the export is
    // named after, but without the intro's lead, so a player showed every cue 3 s early beside the exported movie.
    test("the subtitle file named after the export follows its clock; clock output and a part do not move", async () => {
        const { path, root } = cardedEdit("rs-subtitles-clock-");
        const whole = await edits.writeSubtitles({ value: path, format: "srt" });
        expect(readFileSync(whole.path, "utf8")).toContain("00:00:05,500 --> 00:00:06,500");

        const output = join(root, "output.srt");
        await edits.writeSubtitles({ value: path, format: "srt", out: output, clock: "output" });
        expect(readFileSync(output, "utf8")).toContain("00:00:02,500 --> 00:00:03,500");

        const part = join(root, "part.srt");
        await edits.writeSubtitles({
            value: path,
            format: "srt",
            out: part,
            part: { fromUs: 2_000_000, toUs: 5_000_000 },
        });
        expect(readFileSync(part, "utf8")).toContain("00:00:00,500 --> 00:00:01,500");
    });

    // Round 1 hunt (intro-card-export-clock): the whole export named the card at 0:00 and then chapterPoints' own
    // "Intro" at the card's end, a second intro chapter.
    test("a whole export's chapters name the intro card at 0:00 once and move every marker by it", async () => {
        const { path, root } = cardedEdit("rs-finish-whole-chapters-");
        const movie = join(root, "talk-export.mp4");
        writeFileSync(movie, "movie");
        const written: string[] = [];
        const probe = spyOn(videoProbe, "probeVideo").mockImplementation(async ({ input }) => ({
            path: input,
            durationUs: 16_000_000,
            width: 100,
            height: 100,
            displayWidth: 100,
            displayHeight: 100,
            rotation: 0,
            bytes: 5,
            codec: "h264",
        }));
        const ffmpeg = spyOn(videoProcess, "runVideoCommand").mockImplementation(async ({ command }) => {
            written.push(readFileSync(command[command.indexOf("ffmetadata") + 2] ?? "", "utf8"));
            writeFileSync(command.at(-1) ?? "", "movie");
            return "";
        });
        closing.push(
            () => probe.mockRestore(),
            () => ffmpeg.mockRestore()
        );

        const answer = await edits.finishExport({ value: path, answer: { ok: true, path: movie } });

        expect(answer.chapters).toBe(3);
        expect(written[0]).toContain("START=0\nEND=6000\ntitle=Demo");
        expect(written[0]).toContain("START=6000\nEND=7500\ntitle=Step one");
        expect(written[0]).not.toContain("title=Intro");
    });
});

describe("a part export's chapters on every route", () => {
    /** A 60 s edit with markers at 10, 20 and 30 s. */
    function markedEdit(prefix: string): { path: string; root: string } {
        const root = mkdtempSync(join(tmpdir(), prefix));
        const path = join(root, "talk.edit.json");
        writeProject(path, {
            ...wholeProject({ video: join(root, "talk.mp4"), durationUs: 60_000_000, width: 100, height: 100 }),
            markers: [
                { id: "m1", atUs: 10_000_000, label: "Step 1" },
                { id: "m2", atUs: 20_000_000, label: "Step 2" },
                { id: "m3", atUs: 30_000_000, label: "Step 3" },
            ],
        });
        return { path, root };
    }

    /** The renderer writes a movie, ffprobe answers 15 s, and ffmpeg's chapter metadata is kept. */
    function spyExport(): string[] {
        const written: string[] = [];
        const host = spyOn(serviceClient, "hostExport").mockImplementation(async ({ out }) => {
            const to = out ?? "";
            writeFileSync(to, "movie");
            return { ok: true, path: to };
        });
        const probe = spyOn(videoProbe, "probeVideo").mockImplementation(async ({ input }) => ({
            path: input,
            durationUs: 15_000_000,
            width: 100,
            height: 100,
            displayWidth: 100,
            displayHeight: 100,
            rotation: 0,
            bytes: 5,
            codec: "h264",
        }));
        const ffmpeg = spyOn(videoProcess, "runVideoCommand").mockImplementation(async ({ command }) => {
            written.push(readFileSync(command[command.indexOf("ffmetadata") + 2] ?? "", "utf8"));
            writeFileSync(command.at(-1) ?? "", "movie");
            return "";
        });
        closing.push(
            () => host.mockRestore(),
            () => probe.mockRestore(),
            () => ffmpeg.mockRestore()
        );
        return written;
    }

    // Round 2 hunt (r2-part-export-chapters): exportAs finished the trimmed copy, whose markers before the part are
    // cut, so its first chapter was a generic "Intro", while the window's `recorder finish --from --to` named the
    // marker current at the part start.
    test("exportAs with a part names the chapter current at the part start at 0:00, as finishExport does", async () => {
        const { path, root } = markedEdit("rs-part-chapters-");
        const written = spyExport();
        const part = { fromUs: 25_000_000, toUs: 40_000_000 };

        const answer = await edits.exportAs(path, { part, out: join(root, "part.mp4") });

        expect(answer).toMatchObject({ ok: true, chapters: 2 });
        expect(written[0]).toContain("START=0\nEND=5000\ntitle=Step 2");
        expect(written[0]).toContain("START=5000\nEND=15000\ntitle=Step 3");
        expect(written[0]).not.toContain("title=Intro");

        const movie = join(root, "window.mp4");
        writeFileSync(movie, "movie");
        await edits.finishExport({ value: path, answer: { ok: true, path: movie }, part });
        expect(written[1]).toBe(written[0] ?? "");
    });

    test("chaptersOfPart folds a chapter under 1 s after the part start into the 0:00 chapter", () => {
        const chapters = [
            { at: 0, label: "Intro" },
            { at: 10, label: "Step 1" },
            { at: 20.5, label: "Step 2" },
        ];
        expect(chaptersOfPart(chapters, { from: 20, to: 40 })).toEqual([{ at: 0, label: "Step 2" }]);
        expect(chaptersOfPart(chapters, { from: 19, to: 40 })).toEqual([
            { at: 0, label: "Step 1" },
            { at: 1.5, label: "Step 2" },
        ]);
    });
});

describe("the format an export asks for", () => {
    /** A 10 s edit whose window picked `format`, with chapters off so the MP4 route needs no ffmpeg. */
    function formattedEdit(prefix: string, format: "mp4" | "gif"): { path: string; root: string } {
        const root = mkdtempSync(join(tmpdir(), prefix));
        const path = join(root, "talk.edit.json");
        const project = wholeProject({
            video: join(root, "talk.mp4"),
            durationUs: 10_000_000,
            width: 100,
            height: 100,
        });
        writeProject(path, { ...project, export: { ...project.export, format, chapters: false } });
        return { path, root };
    }

    /** Records what reaches the renderer and ffmpeg; each writes its output, as the real ones do. */
    function spyRenders(): { hostOuts: string[]; ffmpegOuts: string[] } {
        const hostOuts: string[] = [];
        const ffmpegOuts: string[] = [];
        const host = spyOn(serviceClient, "hostExport").mockImplementation(async ({ out }) => {
            const to = out ?? "";
            hostOuts.push(to);
            writeFileSync(to, "movie");
            return { ok: true, path: to };
        });
        const ffmpeg = spyOn(videoProcess, "runVideoCommand").mockImplementation(async ({ command }) => {
            const to = command.at(-1) ?? "";
            ffmpegOuts.push(to);
            writeFileSync(to, "movie");
            return "";
        });
        closing.push(
            () => host.mockRestore(),
            () => ffmpeg.mockRestore()
        );
        return { hostOuts, ffmpegOuts };
    }

    // Round 1 hunt (part-export-format): a part took the edit's export.format over the --out extension, so
    // `export --from --to -o clip.mp4` wrote a GIF, while the same call without --from/--to wrote an MP4.
    test("askedExportFormat: an asked format, then the out extension, then the edit's format, then mp4", () => {
        const gif = { export: { format: "gif" as const } };
        expect(edits.askedExportFormat({ out: "/x/clip.mp4", project: gif })).toBe("mp4");
        expect(edits.askedExportFormat({ out: "/x/clip.GIF", project: { export: { format: "mp4" } } })).toBe("gif");
        expect(edits.askedExportFormat({ project: gif })).toBe("gif");
        expect(edits.askedExportFormat({ project: { export: {} } })).toBe("mp4");
        expect(edits.askedExportFormat({ format: "webm", out: "/x/clip.mp4", project: gif })).toBe("webm");
        expect(edits.askedExportFormat({ out: "/x/clip.mov", project: gif })).toBe("mov");
    });

    test("a part export to clip.mp4 of an edit set to GIF writes an MP4, as a whole export does", async () => {
        const { path, root } = formattedEdit("rs-part-format-", "gif");
        const renders = spyRenders();
        const out = join(root, "clip.mp4");

        const answer = await edits.exportAs(path, { part: { fromUs: 2_000_000, toUs: 5_000_000 }, out });

        expect(answer).toMatchObject({ ok: true, path: out });
        expect(renders.hostOuts).toEqual([out]);
        expect(renders.ffmpegOuts).toEqual([]);
        expect(readProject(path).export.format).toBe("gif");
    });

    test("a part export to clip.gif of an edit set to MP4 makes the GIF from the rendered movie", async () => {
        const { path, root } = formattedEdit("rs-part-format-gif-", "mp4");
        const renders = spyRenders();
        const out = join(root, "clip.gif");

        const answer = await edits.exportAs(path, { part: { fromUs: 2_000_000, toUs: 5_000_000 }, out });

        expect(answer).toMatchObject({ ok: true, path: out });
        expect(renders.ffmpegOuts).toEqual([out]);
        expect(renders.hostOuts).not.toContain(out);
        expect(existsSync(out)).toBe(true);
    });

    test("a part export to an unknown extension is refused, as a whole export is", async () => {
        const { path, root } = formattedEdit("rs-part-format-mov-", "gif");
        const renders = spyRenders();

        const part = await edits.exportAs(path, {
            part: { fromUs: 2_000_000, toUs: 5_000_000 },
            out: join(root, "clip.mov"),
        });
        const whole = await edits.exportAs(path, { out: join(root, "clip.mov") });

        expect(part).toEqual(whole);
        expect(part.ok).toBe(false);
        expect(renders.hostOuts).toEqual([]);
    });
});

describe("a denoised export's render copy", () => {
    // Round 1 hunt (denoise-render-sidecars): the copy renders from .denoise/, where the renderer finds no
    // recording.json, so the burned-in progress bar lost every marker set while recording.
    test("denoisedRenderProject carries the recording's markers beside the edit's own, in time order, and renders the cleaned movie", () => {
        const folder = mkdtempSync(join(tmpdir(), "rs-denoise-"));
        writeFileSync(
            join(folder, "recording.json"),
            SafeJSON.stringify({
                version: 1,
                id: "video-denoise",
                title: "denoise",
                startedAt: "2026-11-09T10:00:00Z",
                displays: [],
                frames: [],
                settings: {
                    markers: [
                        { atMs: 4_000, label: "second step" },
                        { atMs: 1_500, label: "x".repeat(100) },
                    ],
                },
            })
        );
        const path = join(folder, "edit.json");
        const whole = wholeProject({
            video: join(folder, "screen.mp4"),
            durationUs: 10_000_000,
            width: 100,
            height: 100,
        });
        writeProject(path, {
            ...whole,
            markers: [{ id: "m1", atUs: 2_000_000, label: "edit marker" }],
            audio: { ...whole.audio, denoise: { method: "afftdn", reductionDb: 12 } },
        });
        const cleanedPath = join(folder, ".denoise", "screen-abc.mp4");
        const copy = edits.denoisedRenderProject({
            opened: { path, project: readProject(path), fresh: false },
            cleanedPath,
        });

        expect(copy.source.video).toBe(cleanedPath);
        expect(copy.audio).not.toHaveProperty("denoise");
        expect(copy.markers).toEqual([
            { id: "recorded-1", atUs: 1_500_000, label: "x".repeat(80) },
            { id: "m1", atUs: 2_000_000, label: "edit marker" },
            { id: "recorded-0", atUs: 4_000_000, label: "second step" },
        ]);
        // The renderer reads the copy as an edit: a recorded label over the edit markers' cap must not break it.
        const written = join(folder, "denoised.edit.json");
        writeProject(written, copy);
        expect(readProject(written).markers).toHaveLength(3);
        expect(readProject(path).markers).toEqual([{ id: "m1", atUs: 2_000_000, label: "edit marker" }]);
    });
});

describe("the REPL's and the CLI's way to the service", () => {
    /** A saved edit as text, with its folder and its random ids out, so two copies compare. */
    function comparable(path: string): unknown {
        const project = readProject(path);
        const root = path.slice(0, path.lastIndexOf("/"));
        return SafeJSON.parse(
            SafeJSON.stringify(project)
                .replaceAll(root, "<root>")
                .replace(/"id":"[^"]+"/g, '"id":"<id>"'),
            {
                strict: true,
            }
        );
    }

    test("one op saves the same project through the service as in process, and undoes the same way", async () => {
        const ops = [
            { op: "volume", volume: 0.6 },
            { op: "mute", track: 0 },
            { op: "text", from: 1, to: 3, text: "Both ways" },
            { op: "marker", at: 2, label: "Step one" },
        ] as const;
        const local = editFixture("rs-local-");
        const nobody = mkdtempSync(join(tmpdir(), "rs-none-"));
        const inProcess = await applyEdit(local, [...ops], { dir: nobody });

        const { dir } = await serviceFixture();
        const remote = editFixture("rs-remote-");
        const throughService = await applyEdit(remote, [...ops], { dir });

        expect(throughService.project.revision).toBe(inProcess.project.revision);
        expect(comparable(remote)).toEqual(comparable(local));
        expect((await undoLastEdit(remote, { dir })).undone).toEqual(["volume", "mute", "text", "marker"]);
        expect((await undoLastEdit(local, { dir: nobody })).undone).toEqual(["volume", "mute", "text", "marker"]);
        expect(comparable(remote)).toEqual(comparable(local));
    });

    // Regression test: deep test 2026-11-07 R2-RE1 — an agent's undo from the CLI could not be made again: there was no
    // redo command, and the service refused edit.redo for an edit no window held.
    test("redo makes an undone CLI step again, in process and through the service, and a new edit drops it", async () => {
        const ops = [{ op: "marker", at: 2, label: "Step one" }] as const;
        const nobody = mkdtempSync(join(tmpdir(), "rs-none-"));
        const local = editFixture("rs-redo-local-");
        await applyEdit(local, [...ops], { dir: nobody });
        await undoLastEdit(local, { dir: nobody });
        const redone = await redoLastEdit(local, { dir: nobody });
        expect(redone.redone).toEqual(["marker"]);
        expect(redone.project.markers?.map((marker) => marker.label)).toEqual(["Step one"]);
        expect((await undoLastEdit(local, { dir: nobody })).undone).toEqual(["marker"]);

        const { dir } = await serviceFixture();
        const remote = editFixture("rs-redo-remote-");
        await applyEdit(remote, [...ops], { dir });
        await undoLastEdit(remote, { dir });
        expect((await redoLastEdit(remote, { dir })).project.markers?.map((marker) => marker.label)).toEqual([
            "Step one",
        ]);

        await undoLastEdit(remote, { dir });
        await applyEdit(remote, [{ op: "volume", volume: 0.5 }], { dir });
        await expect(redoLastEdit(remote, { dir })).rejects.toThrow("nothing to redo");
    });

    test("the REPL's still reaches the connected host over the service and its answer comes back", async () => {
        const { service } = await serviceFixture();
        const path = editFixture("rs-repl-");
        const asked: unknown[] = [];
        const host = await connect(service.entry, async ({ method, params }) => {
            asked.push({ method, params });
            return { ok: true, path: "/tmp/host-fixture.png", width: 1280, height: 720, atSeconds: 1.5 };
        });
        await host.call<unknown>("hello", hello("host", ["render.still"]));

        // In this process the service answers the REPL's helper itself; another process goes over the socket.
        expect(await hostStill({ path, atSeconds: 1.5, out: "/tmp/out.png" })).toMatchObject({
            ok: true,
            path: "/tmp/host-fixture.png",
            width: 1280,
        });
        expect(await new ServiceHost(service.entry).call("render.still", { path, atSeconds: 2 })).toMatchObject({
            path: "/tmp/host-fixture.png",
        });
        expect(asked).toEqual([
            { method: "render.still", params: { path, atSeconds: 1.5, out: "/tmp/out.png" } },
            { method: "render.still", params: { path, atSeconds: 2 } },
        ]);
    });

    // The lead's list of 2026-11-05 07:55, item 1: an agent that opened an editor window had no way to close it, so a
    // live check pressed the close button through accessibility.
    test("closeEditor and the CLI's close reach the host's window.close, and a busy window's coded refusal comes back", async () => {
        const { service } = await serviceFixture();
        const path = editFixture("rs-close-");
        const asked: unknown[] = [];
        const host = await connect(service.entry, async ({ method, params }) => {
            asked.push({ method, params });

            if (asked.length === 2) {
                throw new RpcError(RPC_ERRORS.windowBusy, "the editor window has a drag that is not saved yet");
            }

            return { closed: true, window: 7 };
        });
        await host.call<unknown>("hello", hello("host", ["window.close"]));

        expect(await new Movie(path).closeEditor()).toEqual({ closed: true, window: 7 });
        await expect(hostCloseEditor({ path })).rejects.toMatchObject({ code: RPC_ERRORS.windowBusy });
        expect(asked).toEqual([
            { method: "window.close", params: { path } },
            { method: "window.close", params: { path } },
        ]);
    });

    test("without a host, window.close answers closed: false for a window nobody lists, and refuses one editor-open.json lists", async () => {
        const { service } = await serviceFixture({
            headless: {
                editorState: () => ({
                    version: 1,
                    updatedAt: "",
                    open: [{ path: "/rec/talk", title: "Talk", window: 7 }],
                }),
            },
        });
        const client = await connect(service.entry);

        expect(await client.call<unknown>("window.close", { path: "/rec/other/screen.edit.json" })).toEqual({
            closed: false,
        });
        await expect(client.call<unknown>("window.close", { path: "/rec/talk/edit.json" })).rejects.toMatchObject({
            code: RPC_ERRORS.hostUnavailable,
        });
        await expect(client.call<unknown>("window.close", { window: 7 })).rejects.toMatchObject({
            code: RPC_ERRORS.hostUnavailable,
        });
        await expect(client.call<unknown>("window.close", {})).rejects.toMatchObject({
            code: RPC_ERRORS.invalidParams,
        });
    });

    // Round 2 (recorder-capture): callerPath resolved every value against the cwd, so `apply <id>` asked the service
    // for "<cwd>/<id>" and was refused while a service ran; a folder path worked.
    test("an edit, an undo and a REPL Movie's edit by a full or short library id reach the service's recording", async () => {
        const id = "video-2026-11-07_00-10-00-5eb1ce11-0000-4000-8000-000000000001";
        const folder = recordingsLibraryDir(id);
        mkdirSync(folder, { recursive: true });
        writeFileSync(
            join(folder, "recording.json"),
            SafeJSON.stringify({
                version: 1,
                id,
                title: "by id",
                startedAt: "2026-11-06T23:10:00Z",
                displays: [],
                frames: [],
            })
        );
        writeFileSync(join(folder, "screen.mp4"), "");
        const path = join(folder, "edit.json");
        writeProject(
            path,
            wholeProject({ video: join(folder, "screen.mp4"), durationUs: 10_000_000, width: 100, height: 100 })
        );

        try {
            const { dir } = await serviceFixture();
            expect((await applyEdit(shortRecordingId(id), [{ op: "volume", volume: 0.5 }], { dir })).path).toBe(path);
            expect(readProject(path).audio.volume).toBe(0.5);
            expect((await undoLastEdit(id, { dir })).undone).toEqual(["volume"]);
            expect(readProject(path).audio.volume).toBe(1);
            const methods = moviesApi.handles.find((handle) => handle.name === "Movie")?.methods ?? [];
            // Its own volume() throws: only a call that went to the service, whose Movie runs it, passes.
            const local = {
                recording: shortRecordingId(id),
                volume: async (_volume: number): Promise<unknown> => {
                    throw new Error("ran in the caller's process");
                },
            };
            await serviceRoutedMovie(local, methods, { dir }).volume(0.25);
            expect(readProject(path).audio.volume).toBe(0.25);
        } finally {
            rmSync(folder, { recursive: true, force: true });
        }
    });

    // H1-111: tools recorder fix, cut-words, cut-fillers and replace-words, and the Movie that stop() and demo() return,
    // saved the edit beside the service, so the window's open session lost its undo history.
    test("recordingMovie, the Movie of the CLI's edit commands, stop() and demo(), edits the window's open session through the service", async () => {
        const { dir, service } = await serviceFixture({ saveDelayMs: 10_000 });
        const path = editFixture("rs-cli-fix-");
        writeProject(
            path,
            applyOp(applyOp(readProject(path), { op: "marker", at: 6.2, label: "Step" }), {
                op: "cut",
                from: 3,
                to: 6.5,
            })
        );
        const window = await connect(service.entry);
        await window.call<unknown>("hello", hello("host"));
        await window.call<unknown>("session.open", { path });
        await window.call<unknown>("edit.apply", {
            path,
            ops: [{ op: "volume", volume: 0.5 }],
            baseRevision: readProject(path).revision,
        });
        const session = service.sessions.get(path);
        expect(session?.undoDepth).toBe(1);

        // In this test the service runs in this process, so a local save would reach the session too: the call itself
        // must go over the socket, as it does from a CLI process that has no session of its own.
        const spy = spyOn(RpcSocketClient.prototype, "call");

        try {
            await recordingMovie(path, undefined, { dir }).fix();
            expect(spy.mock.calls.map(([method]) => method)).toContain("movie.fix");
        } finally {
            spy.mockRestore();
        }

        await Bun.sleep(10);

        expect(session?.current.project.markers?.map((marker) => marker.atUs)).toEqual([6_500_000]);
        expect(session?.undoDepth).toBe(2);
    });

    test("a REPL Movie's edit goes into the window's open session through the service, and runs locally without one", async () => {
        const { dir, service } = await serviceFixture({ saveDelayMs: 10_000 });
        const path = editFixture("rs-movie-");
        const window = await connect(service.entry);
        const heard: RpcNotification[] = [];
        window.onNotification((notification) => heard.push(notification));
        await window.call<unknown>("hello", hello("host"));
        await window.call<unknown>("subscribe", { events: ["project.changed"] });
        await window.call<unknown>("session.open", { path });

        const methods = moviesApi.handles.find((handle) => handle.name === "Movie")?.methods ?? [];
        // Its own volume() throws: only a call that went to the service, whose Movie runs it, passes.
        const local = {
            recording: path,
            volume: async (_volume: number): Promise<unknown> => {
                throw new Error("ran in the caller's process");
            },
        };
        await serviceRoutedMovie(local, methods, { dir }).volume(0.25);
        await Bun.sleep(10);

        expect(service.sessions.get(path)?.current.project.audio.volume).toBe(0.25);
        expect(readProject(path).audio.volume).toBe(0.25);
        expect(heard.map((notification) => Reflect.get(Object(notification.params), "by"))).toEqual(["agent"]);
        expect((await serviceRoutedMovie(new Movie(path), methods, { dir }).info()).audio).toMatchObject({
            volume: 0.25,
        });

        const alone = editFixture("rs-alone-");
        const offline = serviceRoutedMovie(new Movie(alone), methods, { dir: mkdtempSync(join(tmpdir(), "rs-none-")) });
        await offline.volume(0.75);
        expect(readProject(alone).audio.volume).toBe(0.75);
    });

    // Review CLI-F3: only `file` was resolved, so duplicate({ to }), introCard({ logo }) and a frame's background image
    // went to the service as relative paths and landed in, or were looked up in, the service's own folder.
    test("every path a REPL Movie's call or an apply names reaches the service resolved against the caller's cwd", async () => {
        const { dir } = await serviceFixture();
        const path = editFixture("rs-paths-");
        // duplicate() copies the movie too.
        writeFileSync(readProject(path).source.video, "");
        const methods = moviesApi.handles.find((handle) => handle.name === "Movie")?.methods ?? [];
        const cwd = realpathSync(mkdtempSync(join(tmpdir(), "rs-caller-cwd-")));
        writeFileSync(join(cwd, "logo.png"), "");
        writeFileSync(join(cwd, "bg.png"), "");
        const before = process.cwd();
        const spy = spyOn(RpcSocketClient.prototype, "call");
        const movie = serviceRoutedMovie(new Movie(path), methods, { dir });
        process.chdir(cwd);

        try {
            await movie.duplicate({ to: "cut-copy" });
            await movie.introCard({ title: "Demo", logo: "logo.png" });
            await movie.frame({ background: { kind: "image", image: "bg.png" } });
            await movie.apply([{ op: "introCard", logo: "" }]);
            await applyEdit(path, [{ op: "introCard", title: "Demo", logo: "logo.png" }], { dir });
            await movie.apply([{ op: "exportSettings", output: "demo.mp4" }]);
        } finally {
            process.chdir(before);
        }

        const sent = spy.mock.calls
            .filter(([method]) => method.startsWith("movie.") || method === "edit.apply")
            .map(([method, params]) => ({ method, params }));
        spy.mockRestore();
        expect(sent.map((call) => call.method)).toEqual([
            "movie.duplicate",
            "movie.introCard",
            "movie.frame",
            "movie.apply",
            "edit.apply",
            "movie.apply",
        ]);
        expect(sent[0].params).toMatchObject({ to: join(cwd, "cut-copy") });
        expect(sent[1].params).toMatchObject({ title: "Demo", logo: join(cwd, "logo.png") });
        expect(sent[2].params).toMatchObject({ background: { kind: "image", image: join(cwd, "bg.png") } });
        // "" removes the logo: it stays "".
        expect(sent[3].params).toMatchObject({ ops: [{ op: "introCard", logo: "" }] });
        expect(sent[4].params).toMatchObject({ ops: [{ op: "introCard", logo: join(cwd, "logo.png") }] });
        // The export file an edit keeps: a relative one would be found later in the renderer's own folder.
        expect(sent[5].params).toMatchObject({ ops: [{ op: "exportSettings", output: join(cwd, "demo.mp4") }] });
        // A bare ~ is the home folder, as a shell reads it.
        expect(callerParams("duplicate", { to: "~" })).toEqual({ to: homedir() });
        expect(callerParams("duplicate", { to: "~/copy" })).toEqual({ to: join(homedir(), "copy") });
    });

    // Regression test: every `file` was resolved against the caller's cwd, so a bare camera name sent
    // through the service was stored as "<cwd>/camera.mov" and no bubble could load, while the same call without a
    // service stored "camera.mov", which the camera schema reads beside the source movie.
    test("a bare camera file name reaches the service as the caller wrote it, so it stays beside the movie", async () => {
        const { dir } = await serviceFixture();
        const methods = moviesApi.handles.find((handle) => handle.name === "Movie")?.methods ?? [];
        const viaMovie = editFixture("rs-camera-");
        const viaApply = editFixture("rs-camera-apply-");
        const viaCli = editFixture("rs-camera-cli-");
        const local = editFixture("rs-camera-local-");

        for (const path of [viaMovie, viaApply, viaCli, local]) {
            writeFileSync(join(dirname(path), "camera.mov"), "");
        }

        const cwd = realpathSync(mkdtempSync(join(tmpdir(), "rs-caller-cwd-")));
        writeFileSync(join(cwd, "song.mp3"), "");
        const before = process.cwd();
        const spy = spyOn(RpcSocketClient.prototype, "call");
        process.chdir(cwd);

        try {
            await serviceRoutedMovie(new Movie(viaMovie), methods, { dir }).camera({ file: "camera.mov" });
            await serviceRoutedMovie(new Movie(viaApply), methods, { dir }).apply([
                { op: "camera", file: "camera.mov" },
            ]);
            await applyEdit(viaCli, [{ op: "camera", file: "camera.mov" }], { dir });
            // music resolves its file against the cwd in the caller's process too, so it still goes resolved.
            await serviceRoutedMovie(new Movie(viaMovie), methods, { dir }).music({ file: "song.mp3" });
            await applyEdit(local, [{ op: "camera", file: "camera.mov" }], {
                dir: mkdtempSync(join(tmpdir(), "rs-none-")),
            });
        } finally {
            process.chdir(before);
        }

        const sent = spy.mock.calls
            .filter(([method]) => method.startsWith("movie.") || method === "edit.apply")
            .map(([method, params]) => ({ method, params }));
        spy.mockRestore();
        expect(sent.map((call) => call.method)).toEqual(["movie.camera", "movie.apply", "edit.apply", "movie.music"]);
        expect(sent[0].params).toMatchObject({ file: "camera.mov" });
        expect(sent[1].params).toMatchObject({ ops: [{ op: "camera", file: "camera.mov" }] });
        expect(sent[2].params).toMatchObject({ ops: [{ op: "camera", file: "camera.mov" }] });
        expect(sent[3].params).toMatchObject({ file: join(cwd, "song.mp3") });

        for (const path of [viaMovie, viaApply, viaCli, local]) {
            const project = readProject(path);
            expect(project.camera?.file).toBe("camera.mov");
            const movie = cameraMoviePath({ file: project.camera?.file ?? "" }, project.source.video);
            expect(movie).toBe(join(dirname(path), "camera.mov"));
            expect(existsSync(movie)).toBe(true);
        }
    });
});

describe("edits that run at the same time", () => {
    // Regression test: 2026-11-05 recorder service review, finding 1 — a third edit at once overwrote an accepted one
    test("three edits of the file at once keep all three changes, each at its own revision", async () => {
        const path = editFixture("gt-edit-three-");
        const results = await Promise.all([
            editProject(path, [{ op: "text", from: 1, to: 2, text: "A" }]),
            editProject(path, [{ op: "volume", volume: 0.4 }]),
            editProject(path, [{ op: "marker", at: 2, label: "C" }]),
        ]);
        const saved = readProject(path);

        expect(results.map((result) => result.project.revision).sort()).toEqual([2, 3, 4]);
        expect({
            volume: saved.audio.volume,
            texts: saved.texts?.map((text) => text.text),
            markers: saved.markers?.map((marker) => marker.label),
        }).toEqual({ volume: 0.4, texts: ["A"], markers: ["C"] });
    });

    /** Sends edit.apply, cancels it while it computes, and lets it finish after the service heard the cancel. */
    async function cancelWhileComputing(entry: ServiceEntry, path: string) {
        const agent = await connect(entry);
        await agent.call<unknown>("hello", hello("client"));
        const held = holdComputations();
        const controller = new AbortController();
        const answer = agent
            .call<unknown>("edit.apply", { path, ops: [{ op: "volume", volume: 0.2 }] }, { signal: controller.signal })
            .catch((error: unknown) => error);
        await held.entered;
        controller.abort();
        // The connection's next request is answered only once the service took the cancel and let the edit go.
        await agent.call<unknown>("hello", hello("client"));
        held.release();
        await held.settled();
        return answer;
    }

    // Regression test: 2026-11-05 recorder service review, finding 5 — two edits naming one base revision both succeeded
    test("of two edit.apply calls at once that name the same base revision, the second is refused", async () => {
        const { service } = await serviceFixture();
        const path = editFixture("rs-base-");
        const clients = [await connect(service.entry), await connect(service.entry)];
        const held = holdComputations(2);
        const answers = clients.map((client, index) =>
            client
                .call<{ revision: number }>("edit.apply", {
                    path,
                    baseRevision: 1,
                    ops: [{ op: "text", from: 1, to: 2, text: `client ${index}` }],
                })
                .then(
                    (answer) => answer.revision,
                    (error: unknown) => Reflect.get(Object(error), "code")
                )
        );
        await held.entered;
        held.release();

        expect((await Promise.all(answers)).sort((a, b) => a - b)).toEqual([2, RPC_ERRORS.staleRevision]);
        expect(readProject(path).texts).toHaveLength(1);
    });

    // Regression test: 2026-11-05 recorder service review, finding 5 — the base check moved from the service into editProject
    test("an edit.apply without a session that names a revision the file is not at is refused and saves nothing", async () => {
        const { service } = await serviceFixture();
        const path = editFixture("rs-base-stale-");
        const agent = await connect(service.entry);

        await expect(
            agent.call<unknown>("edit.apply", { path, baseRevision: 4, ops: [{ op: "volume", volume: 0.2 }] })
        ).rejects.toMatchObject({ code: RPC_ERRORS.staleRevision });
        expect(readProject(path).audio.volume).toBe(1);
    });

    // Regression test: 2026-11-05 recorder service review, finding 4 — a cancelled edit still saved after its answer
    test("an edit.apply cancelled while it computes is never saved to the file", async () => {
        const { service } = await serviceFixture();
        const path = editFixture("rs-cancel-file-");

        expect(await cancelWhileComputing(service.entry, path)).toMatchObject({ code: RPC_ERRORS.cancelled });
        expect(readProject(path).audio.volume).toBe(1);
    });

    // Regression test: 2026-11-05 recorder service review, finding 4 — a cancelled edit still changed the open session
    test("an edit.apply cancelled while it computes never changes the open session", async () => {
        const { service } = await serviceFixture({ saveDelayMs: 10_000 });
        const path = editFixture("rs-cancel-session-");
        const window = await connect(service.entry);
        await window.call<unknown>("hello", hello("host"));
        await window.call<unknown>("session.open", { path });

        expect(await cancelWhileComputing(service.entry, path)).toMatchObject({ code: RPC_ERRORS.cancelled });
        const session = service.sessions.get(path);
        expect({ volume: session?.current.project.audio.volume, dirty: session?.dirty }).toEqual({
            volume: 1,
            dirty: false,
        });
    });
});

/** A recording control with no capture: it answers status, pause, resume, stop and marker.add, and counts its stops. */
class FakeRecordingControl extends RecorderControl {
    readonly kind = "fake";
    readonly methods: RecorderMethod[] = ["status", "pause", "resume", "stop", "marker.add"];
    state: RecorderState = "recording";
    stops = 0;
    live?: LiveRecordingServer;

    async status(): Promise<RecorderStatus> {
        return { kind: this.kind, title: "Fake", state: this.state, displays: [], frames: 3 };
    }

    async pause(): Promise<{ state: RecorderState }> {
        this.state = "paused";
        this.live?.update({ state: "paused" });
        return { state: this.state };
    }

    async resume(): Promise<{ state: RecorderState }> {
        this.state = "recording";
        this.live?.update({ state: "recording" });
        return { state: this.state };
    }

    /** As the real recorders do, the live recording closes before the stop answers. */
    async stop(): Promise<StopAnswer> {
        this.stops += 1;
        this.live?.close("stopped");
        await Bun.sleep(10);
        return { state: "stopped", outcome: "requested" };
    }

    override async addMarker(label: string): Promise<RecordingMarker> {
        return { atMs: 1500, label };
    }
}

async function waitUntil(what: string, condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`${what} did not happen within ${timeoutMs} ms`);
        }

        await Bun.sleep(20);
    }
}

/** A fake live recording in the service fixture's folder that joins the service there (a short safety poll). */
function liveFixture(dir: string, id = "fake-1") {
    const control = new FakeRecordingControl();
    const liveDir = join(dir, "live");
    const live = new LiveRecordingServer({
        id,
        kind: control.kind,
        title: "Fake",
        folder: join(dir, "library", id),
        control,
        dir: liveDir,
        service: { dir, pollMs: 200 },
    });
    control.live = live;
    closing.push(() => live.close());
    return { control, live, liveDir };
}

describe("live recordings in the service", () => {
    test("a recording joins as a recording connection; a client lists it, calls its control and hears its changes", async () => {
        const { dir, service } = await serviceFixture();
        const { control, live, liveDir } = liveFixture(dir);
        await waitUntil("the join", () => live.joinedService);
        expect(service.liveRecordings().map((row) => [row.id, row.kind, row.state])).toEqual([
            ["fake-1", "fake", "recording"],
        ]);

        const watcher = await connect(service.entry);
        await watcher.call("hello", hello("client"));
        const heard: RpcNotification[] = [];
        watcher.onNotification((notification) => heard.push(notification));
        await watcher.call("subscribe", { events: ["recordings.changed", "recording.event"] });
        const listed = await watcher.call<{ recordings: Array<{ id: string; controls: string[] }> }>(
            "recordings.live",
            {}
        );
        expect(listed.recordings.map((row) => row.id)).toEqual(["fake-1"]);
        expect(listed.recordings[0].controls).toContain("marker.add");

        const client = await RecorderClient.connect("fake-1", { dir: liveDir, service: { dir } });
        closing.push(() => client.close());
        expect(client.via).toBe("service");
        expect(client.entry.folder).toBe(join(dir, "library", "fake-1"));
        const events: string[] = [];
        await client.subscribe((notification) => events.push(notification.event), ["state"]);
        expect(await client.addMarker("Login done")).toEqual({ atMs: 1500, label: "Login done" });
        expect(await client.pause()).toEqual({ state: "paused" });
        await waitUntil("the paused change", () => service.liveRecordings()[0]?.state === "paused");
        await waitUntil("the state event", () => events.includes("state"));
        expect(control.state).toBe("paused");
        expect(await callRecorder({ id: "fake-1", method: "status", dir: liveDir, service: { dir } })).toMatchObject({
            state: "paused",
            frames: 3,
        });
        await expect(client.restart()).rejects.toMatchObject({ code: RPC_ERRORS.unsupported });
        await expect(watcher.call("recording.call", { id: "nobody", method: "status" })).rejects.toMatchObject({
            code: RPC_ERRORS.unknownRecording,
        });

        expect(await client.stop()).toEqual({ state: "stopped", outcome: "requested" });
        expect(live.joinedService).toBe(false);
        await waitUntil("the end", () => service.liveRecordings().length === 0);
        await waitUntil("the ended change", () =>
            heard.some((each) => each.method === "recordings.changed" && Object(each.params).change === "ended")
        );
        expect(
            heard
                .filter((each) => each.method === "recordings.changed")
                .map((each) => [Object(each.params).change, Object(each.params).recording?.state])
        ).toEqual([
            ["changed", "paused"],
            ["ended", undefined],
        ]);
        expect(
            heard.filter((each) => each.method === "recording.event").map((each) => Object(each.params).event)
        ).toEqual(["state", "ended"]);
    });

    test("a service restart never stops a recording: it goes on on its own socket and joins the next service", async () => {
        const { dir, service } = await serviceFixture();
        const { control, live, liveDir } = liveFixture(dir);
        await waitUntil("the join", () => live.joinedService);

        service.stop("restart");
        await waitUntil("the leave", () => !live.joinedService);
        const direct = await RecorderClient.connect("fake-1", { dir: liveDir, service: { dir } });
        expect(direct.via).toBe("socket");
        expect(await direct.addMarker("No service")).toEqual({ atMs: 1500, label: "No service" });
        direct.close();

        const next = await startRecorderService({ dir, idleMs: 0, hostWaitMs: 60 });

        if (next.status !== "started") {
            throw new Error("the second service did not start");
        }

        closing.push(() => next.service.stop("test"));
        await waitUntil("the second join", () => next.service.liveRecordings().length === 1);
        const again = await RecorderClient.connect("fake-1", { dir: liveDir, service: { dir } });
        closing.push(() => again.close());
        expect(again.via).toBe("service");
        expect(await again.status()).toMatchObject({ state: "recording" });
        expect(control.stops).toBe(0);
    });
});

describe("the window's REPL methods on the service", () => {
    test("a movie method that reads the edit file sees the window's change the debounced save has not written yet", async () => {
        const { service } = await serviceFixture({ saveDelayMs: 10_000 });
        const path = editFixture("rs-flush-");
        const window = await connect(service.entry);
        await window.call<unknown>("hello", hello("host"));
        await window.call<unknown>("session.open", { path });
        await window.call<unknown>("edit.apply", { path, ops: [{ op: "volume", volume: 0.3 }] });
        expect(readProject(path).audio.volume).not.toBe(0.3);

        const info = await window.call<{ audio: { volume: number } }>("movie.info", { recording: path });

        expect(info.audio.volume).toBe(0.3);
        expect(readProject(path).audio.volume).toBe(0.3);
    });

    // H1-112: zod drops an unknown key from a plain object, so fix({ dryRun: true }) ran the fix and saved an undo step.
    test("a movie method refuses a key it does not take instead of running without it", async () => {
        const { service } = await serviceFixture();
        const path = editFixture("rs-strict-");
        writeProject(path, applyOp(readProject(path), { op: "marker", at: 6.2, label: "Step" }));
        writeProject(path, applyOp(readProject(path), { op: "cut", from: 3, to: 6.5 }));
        const before = readFileSync(path, "utf8");
        const agent = await connect(service.entry);
        await agent.call<unknown>("hello", hello("client"));

        await expect(agent.call<unknown>("movie.fix", { recording: path, dryRun: true })).rejects.toThrow(
            'Unrecognized key: "dryRun"'
        );
        await expect(agent.call<unknown>("movie.clickGroups", { recording: path, gap: 1 })).rejects.toThrow(
            "did you mean gapSeconds?"
        );
        expect(readFileSync(path, "utf8")).toBe(before);
        // Control: the same call with the keys it takes runs.
        await expect(agent.call<{ fixed: string[] }>("movie.fix", { recording: path })).resolves.toMatchObject({
            fixed: [expect.stringContaining("Step")],
        });
    });
});

describe("the protocol fixture the Swift host tests read", () => {
    /** The notifications whose params have a schema of their own, by method and direction; the service adds the id. */
    const NOTIFICATION_SCHEMAS: Record<string, z.ZodType | undefined> = {
        "recordings.changed service→client": recordingsChangedSchema,
        "recording.event service→client": recordingEventSchema,
        "recording.event recording→service": recordingEventSchema.omit({ id: true }),
    };

    test("the protocol error example carries the evidence a live service sends", async () => {
        const { service } = await serviceFixture();
        const client = await connect(service.entry);
        const failure = await client
            .call("hello", { ...hello("client"), protocol: 2 })
            .catch((error: unknown) => error);
        client.close();
        expect(failure).toBeInstanceOf(RpcError);
        if (!(failure instanceof RpcError)) {
            throw new Error("Expected a refused protocol");
        }
        expect(failure.stack).toContain("at hello (");
        const example = fixture.examples.find(
            (entry) => "reply" in entry && entry.reply?.error?.code === RPC_ERRORS.protocolMismatch
        );
        const error: unknown = example && "reply" in example ? example.reply?.error : undefined;
        expect(error).toEqual({
            code: failure.code,
            message: failure.message,
            stack: "<stack>",
            issue: failure.issue,
        });
    });

    test("the JSON Schema file is what the zod schemas make (bun scripts/recorder/write-protocol-fixtures.ts)", () => {
        expect(SafeJSON.parse(SafeJSON.stringify(protocolJsonSchemas()), { strict: true })).toEqual(schemasFixture);
    });

    test("the editor golden file is what the TypeScript side makes (bun scripts/recorder/write-protocol-fixtures.ts)", () => {
        expect(SafeJSON.parse(SafeJSON.stringify(editorGolden()), { strict: true })).toEqual(goldenFixture);
    });

    test("the screen hit ops file is what the TypeScript side makes (bun scripts/recorder/write-protocol-fixtures.ts)", () => {
        expect(SafeJSON.parse(SafeJSON.stringify(screenHitOpsFixture()), { strict: true })).toEqual(screenOpsFixture);
    });

    test("the golden file has an example of every op tag, and its methods are what a live service's hello lists", async () => {
        const golden = editorGolden();
        const examples = new Set(golden.ops.map((op) => Object(op).op));
        expect(golden.opTags.filter((tag) => !examples.has(tag))).toEqual([]);
        expect(new Set(golden.opTags).size).toBe(golden.opTags.length);

        const { service } = await serviceFixture();
        const client = await connect(service.entry);
        const answer = await client.call<{ methods: string[] }>("hello", hello("client"));
        expect(answer.methods).toEqual(golden.methods);
    });

    const schemasOf = (method: string) =>
        [...serviceApi.methods, ...hostApi.methods].find((each) => each.name === method) ??
        moviesApi.handles
            .find((handle) => handle.name === "Movie")
            ?.methods.map((each) => ({ ...each, name: `movie.${each.name}` }))
            .find((each) => each.name === method);

    test("every example fits its method's schemas, and every method, event and error code has one", () => {
        for (const example of fixture.examples) {
            const schemas = schemasOf(example.method);
            const request = "request" in example ? example.request : undefined;
            const reply = "reply" in example ? example.reply : undefined;
            const notification = "notification" in example ? example.notification : undefined;
            const notified = notification && "params" in notification ? notification.params : undefined;
            const eventSchema = NOTIFICATION_SCHEMAS[`${example.method} ${example.direction}`] ?? schemas?.params;

            if (notified !== undefined && eventSchema) {
                expect({ method: example.method, ok: eventSchema.safeParse(notified).success }).toEqual({
                    method: example.method,
                    ok: true,
                });
            }

            if (schemas && request && "params" in request) {
                const { recording: _recording, ...params } = Object(request.params);
                const input = example.method.startsWith("movie.") ? params : request.params;
                expect({ method: example.method, ok: schemas.params.safeParse(input).success }).toEqual({
                    method: example.method,
                    ok: true,
                });
            }

            if (schemas && reply && "result" in reply) {
                expect({ method: example.method, ok: schemas.result.safeParse(reply.result).success }).toEqual({
                    method: example.method,
                    ok: true,
                });
            }
        }

        const named = new Set(fixture.examples.map((example) => example.method));
        const wanted = [
            ...serviceApi.methods.map((method) => method.name),
            ...HOST_METHODS,
            ...SERVICE_EVENTS,
            "subscribe",
            "$/progress",
            "$/cancel",
        ];
        expect(wanted.filter((method) => !named.has(method))).toEqual([]);
        const codes = fixture.examples.flatMap((example) => {
            const code = "reply" in example ? example.reply?.error?.code : undefined;
            return code === undefined ? [] : [code];
        });
        expect([...new Set(codes)].sort()).toEqual(
            [
                RPC_ERRORS.protocolMismatch,
                RPC_ERRORS.hostTaken,
                RPC_ERRORS.cancelled,
                RPC_ERRORS.cameraDenied,
                RPC_ERRORS.cameraBusy,
                RPC_ERRORS.staleRevision,
                RPC_ERRORS.nothingToRedo,
                RPC_ERRORS.unknownRecording,
                RPC_ERRORS.windowBusy,
            ].sort()
        );
    });
});

describe("the inspector tabs", () => {
    test("the tabs the service, the CLI and the REPL accept are the Swift editor's InspectorTab cases, in order", () => {
        // The Find tab reached the Swift editor after the service schema was written, so render.snapshot refused
        // tab "find" (2026-11-05). One list on each side; this test keeps them equal.
        const swift = readFileSync(
            join(moduleDir(import.meta), "../../macos/GenesisTools/Sources/Parts/Recorder/Editor/EditorModel.swift"),
            "utf8"
        );
        const cases = swift.match(/enum InspectorTab: String[^{]*\{\s*case ([a-z, ]+)\n/)?.[1];
        expect(cases).toBeDefined();
        expect(cases?.split(",").map((name) => name.trim())).toEqual([...EDITOR_TABS]);
    });
});

describe("render.snapshot params", () => {
    test("are the keys the Swift host's snapshotRequest() reads, out aside", () => {
        // The Swift host learnt selectMarker after the service schema was written, so the schema stripped it and no
        // client could ask for a snapshot with a marker selected (2026-11-09). This test keeps both sides equal.
        const swift = readFileSync(
            join(
                moduleDir(import.meta),
                "../../macos/GenesisTools/Sources/Parts/Recorder/Service/RecorderHostMethods.swift"
            ),
            "utf8"
        );
        const body = swift.match(/func snapshotRequest\(\)[^{]*\{([\s\S]*?)\n {8}\}\n/)?.[1];
        expect(body).toBeDefined();
        const read = [...(body ?? "").matchAll(/(?:int|bool|number|optionalPath|span)\("(\w+)"\)|object\["(\w+)"\]/g)]
            .map((match) => match[1] ?? match[2] ?? "")
            .concat(body?.includes("try tab()") ? ["tab"] : []);
        const params = HOST_SCHEMAS["render.snapshot"].params;

        if (!(params instanceof z.ZodObject)) {
            throw new Error("render.snapshot params are no z.object");
        }

        const keys = Object.keys(params.shape).filter((key) => key !== "out");
        expect([...new Set(read)].sort()).toEqual(keys.sort());
    });

    test("keep selectMarker", () => {
        expect(
            HOST_SCHEMAS["render.snapshot"].params.parse({ out: "/tmp/x.png", path: "/tmp/e", selectMarker: 0 })
        ).toMatchObject({ selectMarker: 0 });
    });
});

export type { RecorderService };

describe("a connection to the service that closes under a call", () => {
    /** A server that answers hello, then closes the connection at the next request. */
    function droppingServer(): { socket: string; stop: () => void } {
        const socket = join(mkdtempSync(join(tmpdir(), "rs-drop-")), "s.sock");
        const server = Bun.listen({
            unix: socket,
            socket: {
                data: (connection, chunk) => {
                    for (const line of chunk.toString().split("\n").filter(Boolean)) {
                        const request = SafeJSON.parse(line, { strict: true }) as { id: number; method: string };

                        if (request.method === "hello") {
                            connection.write(`${SafeJSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
                        } else {
                            connection.end();
                        }
                    }
                },
            },
        });
        return { socket, stop: () => server.stop(true) };
    }

    function editFile(): string {
        const folder = mkdtempSync(join(tmpdir(), "rs-drop-edit-"));
        const path = join(folder, "screen.edit.json");
        writeProject(
            path,
            wholeProject({ video: join(folder, "screen.mp4"), durationUs: 5_000_000, width: 64, height: 64 })
        );
        return path;
    }

    const entryOf = (socket: string) => ({ socket }) as Parameters<typeof withServiceClient>[0];

    test("withServiceClient says whether the call left: a refused socket is not sent, a close under a call is", async () => {
        const missing = await withServiceClient(entryOf(join(tmpdir(), "no-such.sock")), async () => 1).catch(
            (error: unknown) => error
        );
        expect(missing).toBeInstanceOf(ServiceConnectionLost);
        expect(missing).toMatchObject({ sent: false });
        const server = droppingServer();

        try {
            const dropped = await withServiceClient(entryOf(server.socket), (client) => client.call("movie.cut")).catch(
                (error: unknown) => error
            );
            expect(dropped).toBeInstanceOf(ServiceConnectionLost);
            expect(dropped).toMatchObject({ sent: true });
        } finally {
            server.stop();
        }
    });

    test("sendOnce sends an edit again when the edit did not move, and refuses with a clear error when it did", async () => {
        const path = editFile();
        const nowhere = mkdtempSync(join(tmpdir(), "rs-none-"));
        const entry = entryOf(join(nowhere, "gone.sock"));
        let localRuns = 0;
        const again = await sendOnce({
            what: "movie.cut",
            recording: path,
            dir: nowhere,
            entry,
            send: async () => {
                throw new ServiceConnectionLost(true, "the recorder service closed the connection");
            },
            local: async () => {
                localRuns++;
                return "done here";
            },
        });
        expect(again).toBe("done here");
        expect(localRuns).toBe(1);

        const moved = sendOnce({
            what: "movie.cut",
            recording: path,
            dir: nowhere,
            entry,
            send: async () => {
                // The service saved the edit, then the connection closed before its answer.
                writeProject(path, readProject(path));
                throw new ServiceConnectionLost(true, "the recorder service closed the connection");
            },
            local: async () => {
                localRuns++;
                return "twice";
            },
        });
        await expect(moved).rejects.toThrow("so it was not sent again: info() shows whether it took effect");
        expect(localRuns).toBe(1);

        const twice = sendOnce({
            what: "movie.cut",
            recording: path,
            dir: nowhere,
            entry,
            send: async () => {
                throw new ServiceConnectionLost(false, "ECONNREFUSED");
            },
            local: async () => {
                throw new ServiceConnectionLost(false, "ECONNREFUSED again");
            },
        });
        await expect(twice).rejects.toThrow("closed twice (ECONNREFUSED; then ECONNREFUSED again)");
    });
});

// Regression test: 2026-11-09 12:50 a window recording with the camera failed at once ("the camera needs
// GenesisTools.app's recorder face connected to the recorder service as its host"): no service ran, and a caller with
// no live service took the headless face, which never answers the camera.
describe("a call only the app answers, with no service running", () => {
    test("starts the service, which launches the face and waits for its hello, and the camera answers", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rs-none-"));
        let launches = 0;
        const recorder = serviceClient.recorderHost({
            dir,
            launch: async () => {
                launches += 1;
                const { service } = await serviceFixture({
                    hostWaitMs: 5_000,
                    headless: {
                        // The face the service launches says hello as the host.
                        open: () => {
                            void connect(service.entry, async ({ method }) =>
                                method === "camera.start" ? { started: true, windowIds: [41] } : { stopped: true }
                            ).then((face) => face.call("hello", hello("host", ["camera.start", "camera.stop"])));
                        },
                    },
                });
                return { status: "started", entry: service.entry };
            },
        });

        expect(await recorder.call("camera.start", { folder: "/rec/talk" })).toEqual({
            started: true,
            windowIds: [41],
        });
        expect(launches).toBe(1);
    });

    test("a service that does not start is the refusal's reason", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rs-none-"));
        const recorder = serviceClient.recorderHost({
            dir,
            launch: async () => ({ status: "failed", reason: "SyntaxError: Export named 'x' not found" }),
        });

        await expect(recorder.call("camera.start", { folder: "/rec/talk" })).rejects.toMatchObject({
            code: RPC_ERRORS.hostUnavailable,
            message: expect.stringContaining("SyntaxError: Export named 'x' not found"),
        });
    });
});

// Regression test: 2026-11-09 00:43, 01:05, 01:12 and 01:33 the service exited for a code change while an export
// ran through it, and each caller failed with "the connection to the recorder service closed while the call ran".
describe("a code change while a call runs", () => {
    test("the service stops only once no call is running", async () => {
        const source = realpathSync(mkdtempSync(join(tmpdir(), "rs-src-")));
        const module = join(source, "loaded-busy.ts");
        writeFileSync(module, "export const loaded = true;\n");
        await import(module);
        const { service } = await serviceFixture({ sourceRoot: source, checkEveryMs: 15 });
        const release = Promise.withResolvers<void>();
        const face = await connect(service.entry, async () => {
            await release.promise;
            return { ok: true, path: "/tmp/out.mp4", bytes: 1024, seconds: 1 };
        });
        await face.call("hello", hello("host", ["render.export"]));
        const client = await connect(service.entry);
        await client.call("hello", hello("client"));
        const exporting = client.call<unknown>("render.export", { path: editFixture("rs-busy-"), out: "/tmp/out.mp4" });
        await Bun.sleep(30);
        const later = new Date(Date.now() + 60_000);
        utimesSync(module, later, later);

        expect(await Promise.race([service.stopped, Bun.sleep(300).then(() => "still running")])).toBe("still running");
        release.resolve();
        await exporting;
        expect(await Promise.race([service.stopped, Bun.sleep(1_000).then(() => "still running")])).toBe(
            "code-changed"
        );
    });
});

describe("building the native recorder ahead of a recording", () => {
    test("the service asks for a prewarm when it starts and at each check", async () => {
        const triggers: string[] = [];
        await serviceFixture({ checkEveryMs: 15, prewarmNative: (trigger) => triggers.push(trigger) });
        await Bun.sleep(80);

        expect(triggers[0]).toBe("recorder-service-start");
        expect(triggers.slice(1)).toContain("recorder-service-check");
    });
});

describe("an editor window is named by its recording folder or, for a plain movie, by the movie", () => {
    const root = mkdtempSync(join(tmpdir(), "open-state-"));
    const loose = join(root, "Desktop");
    const recording = join(root, "rec");
    mkdirSync(loose);
    mkdirSync(recording);
    writeFileSync(join(loose, "demo.mov"), "");
    writeFileSync(join(loose, "other.mov"), "");
    writeFileSync(join(loose, "demo.edit.json"), "{}");
    writeFileSync(join(recording, "recording.json"), "{}");
    writeFileSync(join(recording, "screen.mp4"), "");

    test("two plain movies in one folder get their own keys, and a recording keeps its folder", () => {
        expect(editorWindowKeyOf(join(loose, "demo.mov"))).toBe(join(loose, "demo.mov"));
        expect(editorWindowKeyOf(join(loose, "other.mov"))).toBe(join(loose, "other.mov"));
        expect(editorWindowKeyOf(join(loose, "demo.edit.json"))).toBe(join(loose, "demo.mov"));
        expect(editorWindowKeyOf(join(recording, "edit.json"))).toBe(recording);
        expect(editorWindowKeyOf(join(recording, "screen.mp4"))).toBe(recording);
        expect(editorWindowKeyOf(recording)).toBe(recording);
    });
});

// What the recorder's readers and its CLI rely on in the host part (pid claim, service.json, socket, exits), pinned
// before the service moved onto the shared host (src/utils/rpc/service-host.ts, F0r).
describe("the recorder service's host part", () => {
    const entryRecord = z.record(z.string(), z.unknown());
    const readEntryFile = (dir: string) =>
        entryRecord.parse(SafeJSON.parse(readFileSync(join(dir, "service.json"), "utf8"), { strict: true }));
    /** A module the service loaded, under a root of its own, whose change the service watches. */
    async function watchedModule(prefix: string) {
        const source = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
        const module = join(source, "loaded.ts");
        writeFileSync(module, "export const loaded = true;\n");
        // Written a minute ago: a write in the service's own start millisecond would read as a change.
        const earlier = new Date(Date.now() - 60_000);
        utimesSync(module, earlier, earlier);
        await import(module);
        return {
            source,
            change: () => {
                const later = new Date(Date.now() + 60_000);
                utimesSync(module, later, later);
            },
        };
    }
    /** The socket a folder gets: `service.sock`, or a hashed name when that path would pass 103 bytes. */
    const socketOf = (dir: string) => {
        const plain = join(dir, "service.sock");
        return Buffer.byteLength(plain) <= 103
            ? plain
            : join(dir, `${createHash("sha1").update("service").digest("hex").slice(0, 16)}.sock`);
    };
    const outcome = (stopped: Promise<string>, ms: number) =>
        Promise.race([stopped, Bun.sleep(ms).then(() => "still running")]);

    test("service.json names the protocol, the pid and its command line, the socket, the start and its stamp, and nothing more", async () => {
        const watched = await watchedModule("rs-entry-");
        const { dir, service } = await serviceFixture({ sourceRoot: watched.source });
        const written = readEntryFile(dir);
        const pidCommand = readProcessCommand(process.pid);

        expect(Object.keys(written)).toEqual([
            "version",
            "protocol",
            "pid",
            ...(pidCommand ? ["pidCommand"] : []),
            "socket",
            "startedAt",
            "codeStamp",
        ]);
        expect(written).toEqual({
            version: 1,
            protocol: SERVICE_PROTOCOL,
            pid: process.pid,
            ...(pidCommand ? { pidCommand } : {}),
            socket: socketOf(dir),
            startedAt: new Date(service.entry.codeStamp).toISOString(),
            codeStamp: service.entry.codeStamp,
        });
        expect(written).toEqual({ ...service.entry });
        expect(readLiveService(dir)).toEqual(service.entry);
        expect(existsSync(join(dir, "service.pid"))).toBe(true);
    });

    test("a folder whose socket path would pass 103 bytes listens on the hashed name, and a client reaches it there", async () => {
        const dir = join(mkdtempSync(join(tmpdir(), "rs-long-")), "x".repeat(96));
        const start = await startRecorderService({ dir, idleMs: 0, hostWaitMs: 60 });

        if (start.status !== "started") {
            throw new Error("the service did not start");
        }

        closing.push(() => start.service.stop("test"));
        const hashed = join(dir, `${createHash("sha1").update("service").digest("hex").slice(0, 16)}.sock`);
        expect(socketOf(dir)).toBe(hashed);
        expect(start.service.entry.socket).toBe(hashed);
        expect(readEntryFile(dir).socket).toBe(hashed);
        const client = await connect(start.service.entry);
        expect(await client.call<{ protocol: number }>("hello", hello("client"))).toMatchObject({
            protocol: SERVICE_PROTOCOL,
        });
    });

    test("a stop removes service.json, the socket and the pid file, but leaves the service.json a newer service wrote", async () => {
        const { dir, service } = await serviceFixture();
        service.stop("test");

        expect(await service.stopped).toBe("test");
        expect(existsSync(join(dir, "service.json"))).toBe(false);
        expect(existsSync(service.entry.socket)).toBe(false);
        expect(existsSync(join(dir, "service.pid"))).toBe(false);

        const next = await startRecorderService({ dir, idleMs: 0, hostWaitMs: 60 });

        if (next.status !== "started") {
            throw new Error("the second service did not start");
        }

        const newer = { ...next.service.entry, pid: process.pid + 100_000 };
        writeFileSync(join(dir, "service.json"), SafeJSON.stringify(newer, null, 2));
        next.service.stop("test");

        expect(await next.service.stopped).toBe("test");
        expect(readEntryFile(dir)).toMatchObject({ pid: newer.pid });
        expect(existsSync(next.service.entry.socket)).toBe(false);
    });

    test("an open edit session keeps it from the idle exit; once released, it exits for idleness", async () => {
        const { service } = await serviceFixture({ idleMs: 30, checkEveryMs: 15 });
        const session = await service.sessions.hold(editFixture("rs-keep-"));

        expect(await outcome(service.stopped, 250)).toBe("still running");
        service.sessions.release(session.path);
        expect(await outcome(service.stopped, 1_000)).toBe("idle");
    });

    test("an open edit session does not keep it from the exit on a code change, and the stop saves the session's change", async () => {
        const watched = await watchedModule("rs-session-src-");
        const { service } = await serviceFixture({ sourceRoot: watched.source, checkEveryMs: 15, saveDelayMs: 60_000 });
        const path = editFixture("rs-session-");
        const session = await service.sessions.hold(path);
        await session.apply([{ op: "text", from: 1, to: 2, text: "Unsaved" }], { by: "editor" });
        expect(readProject(path).revision).toBe(1);

        watched.change();
        expect(await outcome(service.stopped, 1_000)).toBe("code-changed");
        expect(readProject(path).texts?.map((text) => text.text)).toEqual(["Unsaved"]);
        expect(service.sessions.size).toBe(0);
    });

    test("a live recording keeps it from the exit on a code change while no call runs; it exits once the recording leaves", async () => {
        const watched = await watchedModule("rs-live-src-");
        const { dir, service } = await serviceFixture({ sourceRoot: watched.source, checkEveryMs: 15 });
        const { live } = liveFixture(dir);
        await waitUntil("the join", () => live.joinedService);

        watched.change();
        expect(await outcome(service.stopped, 300)).toBe("still running");
        live.close();
        expect(await outcome(service.stopped, 1_000)).toBe("code-changed");
    });

    test("launchRecorderService answers the service that runs in the recordings' folder with its service.json, starting nothing", async () => {
        const dir = recorderServiceDir();
        expect(dir).toContain("gt-test-home-");
        const start = await startRecorderService({ dir, idleMs: 0, hostWaitMs: 60 });

        if (start.status !== "started") {
            throw new Error("the service did not start");
        }

        closing.push(() => start.service.stop("test"));
        const launch = await launchRecorderService();

        expect(launch).toEqual({ status: "running", entry: readLiveService(dir) ?? start.service.entry });
        expect(launch.status === "failed" ? [] : Object.keys(launch.entry)).toEqual(Object.keys(readEntryFile(dir)));
    });
});
