import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { readProject, wholeProject, writeProject } from "@genesiscz/utils/recording-editor/project";
import type { RpcProgress } from "@genesiscz/utils/rpc/peer";
import { type RpcNotification, RpcSocketClient, type RpcSocketClientOptions } from "@genesiscz/utils/rpc/socket-client";
import {
    RecorderControl,
    type RecorderMethod,
    type RecorderState,
    type RecorderStatus,
    type RecordingMarker,
    RPC_ERRORS,
    type StopAnswer,
} from "@genesiscz/utils/screen-recorder/control";
import { callRecorder, LiveRecordingServer, RecorderClient } from "@genesiscz/utils/screen-recorder/live";
import type { z } from "zod";
import fixture from "./__fixtures__/service-protocol.json";
import * as edits from "./edit";
import { editProject, readUndoSteps, undoEdit } from "./edit";
import { EditSession, EditSessions, type ProjectChanged } from "./edit-session";
import type { HeadlessDeps } from "./host";
import { EDITOR_TABS } from "./library";
import { applyEdit, serviceRoutedMovie, undoLastEdit } from "./movie-client";
import { type RecorderService, type RecorderServiceOptions, startRecorderService } from "./service";
import { hostStill, ServiceHost } from "./service-client";
import {
    HOST_METHODS,
    hostApi,
    readLiveService,
    recordingEventSchema,
    recordingsChangedSchema,
    SERVICE_EVENTS,
    SERVICE_PROTOCOL,
    type ServiceEntry,
    serviceApi,
} from "./service-protocol";
import { Movie, moviesApi } from "./toolset";

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
        expect(await client.call<unknown>("window.open", { path: "/rec/talk/screen.edit.json", focus: false })).toEqual(
            {
                opened: true,
                window: 7,
            }
        );
        expect(opened[0]).toEqual(
            expect.arrayContaining(["--recorder", "--edit", "/rec/talk/screen.edit.json", "--no-focus"])
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

describe("the protocol fixture the Swift host tests read", () => {
    /** The notifications whose params have a schema of their own, by method and direction; the service adds the id. */
    const NOTIFICATION_SCHEMAS: Record<string, z.ZodType | undefined> = {
        "recordings.changed service→client": recordingsChangedSchema,
        "recording.event service→client": recordingEventSchema,
        "recording.event recording→service": recordingEventSchema.omit({ id: true }),
    };
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

export type { RecorderService };
