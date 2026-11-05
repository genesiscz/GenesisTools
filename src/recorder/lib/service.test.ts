import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProject, wholeProject, writeProject } from "@genesiscz/utils/recording-editor/project";
import { RPC_ERRORS } from "@genesiscz/utils/screen-recorder/control";
import { readUndoSteps, undoEdit } from "./edit";
import { EditSession, EditSessions, type ProjectChanged } from "./edit-session";

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
