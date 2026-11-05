import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { readProject, wholeProject, writeProject } from "@genesiscz/utils/recording-editor/project";
import type { RpcProgress } from "@genesiscz/utils/rpc/peer";
import { type RpcNotification, RpcSocketClient, type RpcSocketClientOptions } from "@genesiscz/utils/rpc/socket-client";
import { RPC_ERRORS } from "@genesiscz/utils/screen-recorder/control";
import fixture from "./__fixtures__/service-protocol.json";
import { readUndoSteps, undoEdit } from "./edit";
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

function hello(role: "host" | "client", answers?: string[]) {
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

describe("the protocol fixture the Swift host tests read", () => {
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
