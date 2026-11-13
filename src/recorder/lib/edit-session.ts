import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { isArbitrationBusy, withPathArbitrationSync } from "@genesiscz/utils/process/path-arbitration";
import {
    applyOp,
    type EditOp,
    type EditProject,
    type OpFacts,
    parseProject,
    projectFileText,
    writeProject,
} from "@genesiscz/utils/recording-editor/project";
import { RPC_ERRORS, RpcError } from "@genesiscz/utils/screen-recorder/control";
import {
    ARBITER_BUSY_WAIT_MS,
    computeEdit,
    EDIT_REPLAYS,
    editPathOf,
    inItsFolder,
    type OwnedEdit,
    openProject,
    ownedEdit,
    readUndoJournal,
    throwIfEditCancelled,
    type UndoStep,
    writeUndoJournal,
} from "./edit";
import { recordedMarkersOf } from "./moments";

const { log } = logger.scoped("recorder-edit-session");

/** A change saves this long after the last one, so a drag writes once rather than sixty times (Cap's rule). */
export const SAVE_DELAY_MS = 250;
/** The steps an open session keeps to undo; the undo file keeps the newest `UNDO_STEPS` of them. */
export const SESSION_UNDO_STEPS = 200;

/** What subscribers hear after each change: `project.changed`. */
export interface ProjectChanged {
    path: string;
    revision: number;
    /** Who made it: `agent` (the REPL, the CLI), `editor` (the window), or the writer named in the file. */
    by: string;
    /**
     * The editor window that made it (its `session.open` holder): every window shares the app's one connection, so
     * `by` says `editor` for each, and a window ignores only the changes that name its own holder.
     */
    holder?: string;
    /** The change undid or redid one before it; absent for an edit. */
    action?: "undo" | "redo";
}

/** Who makes a change: `by` for every subscriber, and the editor window's holder when a window made it. */
export interface ChangeWriter {
    by: string;
    holder?: string;
}

export interface EditAnswer {
    revision: number;
    project: EditProject;
    warnings?: string[];
    removedIdleUs?: Array<[number, number]>;
    loudness?: { measuredLufs: number | null; volume: number };
    /** False when the ops changed nothing: no new revision and no undo step, so a window drops the step it added. */
    changed?: false;
}

/** A change made since the last save: ops can be applied again on a newer file, an undo or redo cannot. */
type Unsaved = { kind: "ops"; ops: readonly EditOp[]; facts: readonly OpFacts[] } | { kind: "restore"; what: string };

interface RedoStep {
    /** The edit as the undo found it. */
    after: EditProject;
    ops: string[];
}

interface Preview {
    ops: readonly EditOp[];
    answer: PromiseWithResolvers<{ project: EditProject; superseded?: true }>;
}

interface Gesture {
    /** The ops of the newest preview that applied; commit makes them one undo step. */
    ops?: readonly EditOp[];
    draft?: EditProject;
    /** The previews running now; commit waits for them. */
    running?: Promise<void>;
    /** The next preview; a newer one replaces it, and the replaced one answers `superseded`. */
    waiting?: Preview;
}

function stale(message: string): RpcError {
    return new RpcError(RPC_ERRORS.staleRevision, message);
}

/**
 * Writes the project with the revision it carries (each change in memory took the next one already), and answers the
 * text it wrote.
 */
function saveAt(path: string, project: EditProject): string {
    return projectFileText(
        writeProject(path, { ...project, revision: project.revision - 1 }, project.updatedBy ?? "agent")
    );
}

/** The edit file as it is: its exact text, which tells one save from another, and its project. */
function readDiskFile(path: string): { text: string; project: EditProject } | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    const text = readFileSync(path, "utf8");
    return { text, project: inItsFolder(path, parseProject(text, path)) };
}

/**
 * The one owner of a recording's edit.json: the recorder service's resident one while a window holds the edit, or a
 * short-lived one that `withEditSession` opens for one undo, redo or collapse. It reads the file once, applies ops in
 * memory with the same `applyOp` and measurements as `editProject`, keeps one undo stack with redo, previews drags
 * without saving, and saves 250 ms after the last change. Before each change and each save it reads the file: when
 * its text is not the text this session last read or wrote, another writer (the window, a CLI without the service)
 * saved since, even one that gave its file the same revision, and unsaved ops are applied again on the new file once.
 * When that fails the session takes the file as it is and refuses with `staleRevision`.
 */
export class EditSession {
    private project: EditProject;
    private fresh: boolean;
    /** The file's text at the last read or write; null while the edit has no file. */
    private diskText: string | null;
    private unsaved: Unsaved[] = [];
    private undoSteps: UndoStep[];
    private redoSteps: RedoStep[] = [];
    private readonly gestures = new Map<string, Gesture>();
    private timer?: ReturnType<typeof setTimeout>;
    private retrySaveUntil?: number;
    private turn: Promise<unknown> = Promise.resolve();
    private closed = false;
    /** Why there is nothing to undo when the file's history ended at another writer's save, which has its own undo. */
    private undoRefusal?: string;

    private constructor(
        readonly path: string,
        opened: { project: EditProject; fresh: boolean; text: string | null },
        private readonly options: { onChange: (change: ProjectChanged) => void; saveDelayMs: number }
    ) {
        this.project = opened.project;
        this.fresh = opened.fresh;
        this.diskText = opened.text;
        // The file's history continues here when it ends at this revision; otherwise undo refuses and says where the
        // undo of the newer change lives.
        const { steps, redo } = readUndoJournal(path);
        const last = steps.at(-1);
        this.undoSteps = last?.afterRevision === opened.project.revision ? steps : [];

        if (last && this.undoSteps.length === 0) {
            const { revision, updatedBy } = opened.project;
            this.undoRefusal = `the edit changed since the last change made here (revision ${revision}${updatedBy ? ` by ${updatedBy}` : ""}, not ${last.afterRevision}); undo it where it was made, for example ⌘Z in the editor window`;
        }

        // The file's redo too, while the undo it keeps was the edit's last change.
        if (redo.at(-1)?.undoneRevision === opened.project.revision) {
            this.redoSteps = redo.map((step) => ({ after: step.after, ops: step.ops ?? [] }));
        }
    }

    /** Opens a recording's edit (a library id, `last`, a folder, a movie or an edit file). */
    static async open(
        value: string,
        options: { onChange: (change: ProjectChanged) => void; saveDelayMs?: number }
    ): Promise<EditSession> {
        const opened = await openProject(value);
        // The text and the project of one read, so a save between two reads is never taken for this session's own.
        const disk = readDiskFile(opened.path);
        log.debug({ path: opened.path, revision: opened.project.revision, fresh: opened.fresh }, "edit session opened");
        return new EditSession(opened.path, disk ? { ...disk, fresh: false } : { ...opened, text: null }, {
            onChange: options.onChange,
            saveDelayMs: options.saveDelayMs ?? SAVE_DELAY_MS,
        });
    }

    get current(): { project: EditProject; revision: number } {
        return { project: this.project, revision: this.project.revision };
    }

    get undoDepth(): number {
        return this.undoSteps.length;
    }

    get redoDepth(): number {
        return this.redoSteps.length;
    }

    /** True while a change waits for its save. */
    get dirty(): boolean {
        return this.unsaved.length > 0;
    }

    /** Applies ops as one change and one undo step. `baseRevision`: refused when the edit is at another revision. */
    apply(ops: readonly EditOp[], options: ChangeWriter & { baseRevision?: number }): Promise<EditAnswer> {
        return this.exclusive(async () => {
            this.syncWithDisk();

            if (options.baseRevision !== undefined && options.baseRevision !== this.project.revision) {
                throw stale(
                    `the edit is at revision ${this.project.revision}${this.project.updatedBy ? ` (by ${this.project.updatedBy})` : ""}, not ${options.baseRevision}`
                );
            }

            let base = this.project;
            const recordedMarkers = recordedMarkersOf({ path: this.path, project: base });
            let edit = await computeEdit({ project: base, ops, fresh: this.fresh, recordedMarkers });

            // A save during the computation (the timer, a render) may have taken in another writer's file: the ops
            // run again on the edit as it is now, with the measurements they had, so this change keeps that file.
            while (this.project !== base) {
                if (options.baseRevision !== undefined && options.baseRevision !== this.project.revision) {
                    throw stale(`the edit moved to revision ${this.project.revision}, not ${options.baseRevision}`);
                }
                base = this.project;
                edit = await computeEdit({ project: base, ops, fresh: this.fresh, facts: edit.facts, recordedMarkers });
            }

            const extras = {
                ...(edit.removedIdleUs.length ? { removedIdleUs: edit.removedIdleUs } : {}),
                ...(edit.loudness ? { loudness: edit.loudness } : {}),
                ...(edit.warnings.length ? { warnings: edit.warnings } : {}),
            };

            if (!edit.changed) {
                return { revision: this.project.revision, project: this.project, changed: false, ...extras };
            }

            this.change({
                next: edit.project,
                writer: options,
                ops: ops.map((op) => op.op),
                unsaved: { kind: "ops", ops, facts: edit.facts },
            });
            return { revision: this.project.revision, project: this.project, ...extras };
        });
    }

    /** Puts the edit back as it was before its last change; the revision still rises. */
    undo(options: ChangeWriter): Promise<EditAnswer & { undone: string[] }> {
        return this.exclusive(async () => {
            throwIfEditCancelled();
            this.syncWithDisk();
            const step = this.undoSteps.at(-1);

            if (!step) {
                throw new RpcError(RPC_ERRORS.nothingToUndo, this.undoRefusal ?? "nothing to undo in this edit");
            }

            const undone = this.project;
            this.undoSteps.pop();
            this.redoSteps.push({ after: undone, ops: step.ops ?? [] });
            this.replace({ next: step.before, writer: options, unsaved: { kind: "restore", what: "undo" } });
            // The step below now ends at this revision, so the next undo goes one step further back.
            const below = this.undoSteps.at(-1);

            if (below) {
                below.afterRevision = this.project.revision;
            }

            return { revision: this.project.revision, project: this.project, undone: step.ops ?? [] };
        });
    }

    /** Makes the last undone change again. */
    redo(options: ChangeWriter): Promise<EditAnswer & { redone: string[] }> {
        return this.exclusive(async () => {
            throwIfEditCancelled();
            this.syncWithDisk();
            const step = this.redoSteps.pop();

            if (!step) {
                throw new RpcError(RPC_ERRORS.nothingToRedo, "nothing to redo in this edit");
            }

            const before = this.project;
            this.replace({ next: step.after, writer: options, unsaved: { kind: "restore", what: "redo" } });
            this.pushUndo({ before, afterRevision: this.project.revision, ops: step.ops });
            return { revision: this.project.revision, project: this.project, redone: step.ops };
        });
    }

    /** Makes every step pushed since the undo had `depth` steps into one, so a multi-step change undoes at once. */
    collapseUndo(depth: number): void {
        const added = this.undoSteps.slice(depth);
        const first = added[0];
        const last = added.at(-1);

        if (!first || !last || added.length < 2) {
            return;
        }

        this.undoSteps = [
            ...this.undoSteps.slice(0, depth),
            { before: first.before, afterRevision: last.afterRevision, ops: added.flatMap((step) => step.ops ?? []) },
        ];

        // Nothing waits for a save: the undo file gets the collapsed history now.
        if (this.unsaved.length === 0 && this.diskText !== null) {
            this.writeJournal();
        }
    }

    /** Starts a drag: its previews apply to the edit as it is, and only its commit changes it. */
    beginGesture(id: string): { project: EditProject; revision: number } {
        this.cancelGesture(id);
        this.gestures.set(id, {});
        return this.current;
    }

    /**
     * Applies ops to the edit as it is, for a drag's frame: no save, no undo step. Each preview's ops replace the
     * previous preview's. One preview runs at a time; a newer one replaces the one waiting, which answers superseded.
     */
    previewGesture(id: string, ops: readonly EditOp[]): Promise<{ project: EditProject; superseded?: true }> {
        const gesture = this.gestures.get(id);

        if (!gesture) {
            return Promise.reject(new RpcError(RPC_ERRORS.invalidParams, `no gesture ${id}; begin it first`));
        }

        gesture.waiting?.answer.resolve({ project: gesture.draft ?? this.project, superseded: true });
        const answer = Promise.withResolvers<{ project: EditProject; superseded?: true }>();
        gesture.waiting = { ops, answer };

        if (!gesture.running) {
            gesture.running = this.runPreviews(gesture).finally(() => {
                gesture.running = undefined;
            });
        }

        return answer.promise;
    }

    /** Ends a drag: its last preview's ops become one change and one undo step. */
    async commitGesture(id: string, options: ChangeWriter): Promise<EditAnswer> {
        const gesture = this.gestures.get(id);

        if (!gesture) {
            throw new RpcError(RPC_ERRORS.invalidParams, `no gesture ${id}; begin it first`);
        }

        while (gesture.running) {
            await gesture.running;
        }

        this.gestures.delete(id);

        if (!gesture.ops?.length) {
            return { ...this.current, changed: false };
        }

        return this.apply(gesture.ops, options);
    }

    /** Ends a drag with no change: the edit is as it was at its begin. */
    cancelGesture(id: string): { project: EditProject; revision: number } {
        const gesture = this.gestures.get(id);
        gesture?.waiting?.answer.resolve({ project: this.project, superseded: true });
        this.gestures.delete(id);
        return this.current;
    }

    /**
     * The undo file gets the session's steps and its redo list, so a redo outlives the session as an undo does. Each
     * redo step may run while the edit is at this revision; the next session's redo moves that on as it redoes.
     */
    private writeJournal(): void {
        const undoneRevision = this.project.revision;
        writeUndoJournal(this.path, {
            steps: this.undoSteps,
            redo: this.redoSteps.map((step) => ({ after: step.after, undoneRevision, ops: step.ops })),
        });
    }

    /** The recording's folder is gone (moved or trashed) while the session holds it. */
    get moved(): boolean {
        return !existsSync(dirname(this.path));
    }

    /** Saves now when a change waits for its save. Throws `staleRevision` when a newer file could not take it. */
    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }

        if (this.unsaved.length === 0) {
            return;
        }

        // The recording was moved or trashed: a save would make its folder again (and Put Back would then fail).
        if (this.moved) {
            log.warn({ path: this.path }, "the recording's folder is gone; its unsaved edit stays unsaved");
            return;
        }

        try {
            withPathArbitrationSync(this.path, () => {
                this.syncWithDisk();

                if (this.unsaved.length === 0) {
                    return;
                }

                this.diskText = saveAt(this.path, this.project);
                this.writeJournal();
                this.unsaved = [];
                log.debug({ path: this.path, revision: this.project.revision }, "edit session saved");
            });
            this.retrySaveUntil = undefined;
        } catch (error) {
            if (isArbitrationBusy(error)) {
                this.retrySaveUntil ??= Date.now() + 10_000;
                if (Date.now() < this.retrySaveUntil) {
                    this.scheduleSave();
                }
            }
            throw error;
        }
    }

    /**
     * Saves now as `flush` does, but waits while another process saves the edit and tries again, as `editProject` does,
     * then refuses with `staleRevision`. A short-lived session saves this way: nothing would run `flush`'s retry later.
     */
    async save(): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            try {
                this.flush();
                return;
            } catch (error) {
                if (!isArbitrationBusy(error)) {
                    throw error;
                }

                if (attempt >= EDIT_REPLAYS) {
                    clearTimeout(this.timer);
                    this.timer = undefined;
                    throw stale(`another process kept saving the edit (${EDIT_REPLAYS + 1} tries); nothing was saved`);
                }

                await Bun.sleep(ARBITER_BUSY_WAIT_MS);
            }
        }
    }

    /** Saves what waits and ends the session; later calls are refused, and so is work it accepted and did not finish. */
    close(): void {
        if (this.closed) {
            return;
        }

        this.flush();
        this.closed = true;
        for (const id of [...this.gestures.keys()]) {
            this.cancelGesture(id);
        }
        log.debug({ path: this.path }, "edit session closed");
    }

    private exclusive<T>(work: () => Promise<T>): Promise<T> {
        if (this.closed) {
            return Promise.reject(this.closedError());
        }

        const next = this.turn.then(() => {
            if (this.closed) {
                throw this.closedError();
            }

            return work();
        });
        this.turn = next.catch(() => undefined);
        return next;
    }

    private async runPreviews(gesture: Gesture): Promise<void> {
        for (let preview = gesture.waiting; preview; preview = gesture.waiting) {
            gesture.waiting = undefined;

            try {
                const edit = await computeEdit({ project: this.project, ops: preview.ops, fresh: false });
                gesture.ops = preview.ops;
                gesture.draft = edit.project;
                preview.answer.resolve({ project: edit.project });
            } catch (error) {
                preview.answer.reject(error);
            }
        }
    }

    private pushUndo(step: UndoStep): void {
        this.undoSteps = [...this.undoSteps, step].slice(-SESSION_UNDO_STEPS);
    }

    /** A change: the next revision, one undo step, a save soon, a notification. */
    private change({
        next,
        writer,
        ops,
        unsaved,
    }: {
        next: EditProject;
        writer: ChangeWriter;
        ops: string[];
        unsaved: Unsaved;
    }) {
        const before = this.project;
        this.replace({ next, writer, unsaved });
        this.pushUndo({ before, afterRevision: this.project.revision, ops });
        this.redoSteps = [];
    }

    private closedError(): Error {
        return new Error(`the edit session of ${this.path} is closed`);
    }

    private replace({ next, writer, unsaved }: { next: EditProject; writer: ChangeWriter; unsaved: Unsaved }): void {
        const { by, holder } = writer;
        // The close saved the session last; a change that finished its computation after it would never be saved.
        if (this.closed) {
            throw this.closedError();
        }

        throwIfEditCancelled();
        this.project = { ...next, revision: this.project.revision + 1, updatedBy: by };
        // In memory the edit exists now; the file may not yet (diskText stays null until the save).
        this.fresh = false;
        this.unsaved.push(unsaved);
        this.scheduleSave();
        const action =
            unsaved.kind === "restore" && (unsaved.what === "undo" || unsaved.what === "redo")
                ? unsaved.what
                : undefined;
        this.options.onChange({
            path: this.path,
            revision: this.project.revision,
            by,
            ...(holder ? { holder } : {}),
            ...(action ? { action } : {}),
        });
    }

    private scheduleSave(): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }

        this.timer = setTimeout(() => {
            this.timer = undefined;

            try {
                this.flush();
            } catch (error) {
                log.warn({ error, path: this.path }, "the edit session's save was refused; it took the newer file");
            }
        }, this.options.saveDelayMs);
    }

    /**
     * Another writer saved since this session last read or wrote: take its file, and apply the unsaved ops on it
     * once (with the measurements they had). The history before its change ends there.
     */
    private syncWithDisk(): void {
        const file = readDiskFile(this.path);

        if (!file || file.text === this.diskText) {
            return;
        }

        const disk = file.project;
        const by = disk.updatedBy ?? "another process";
        log.info(
            { path: this.path, disk: disk.revision, ours: this.project.revision, unsaved: this.unsaved.length, by },
            "the edit changed on disk under the session"
        );
        const unsaved = this.unsaved;
        const latest = this.project;
        this.undoSteps = [];
        this.redoSteps = [];
        this.undoRefusal = undefined;
        this.diskText = file.text;
        this.fresh = false;
        this.unsaved = [];

        try {
            let next = disk;

            for (const change of unsaved) {
                if (change.kind === "restore") {
                    throw new Error(`an ${change.what} cannot be made again on a newer file`);
                }

                for (const [index, op] of change.ops.entries()) {
                    next = applyOp(next, op, change.facts[index]);
                }
            }

            if (unsaved.length === 0) {
                this.project = disk;
                this.options.onChange({ path: this.path, revision: disk.revision, by });
                return;
            }

            this.project = {
                ...next,
                revision: Math.max(latest.revision, disk.revision) + 1,
                updatedBy: latest.updatedBy,
            };
            // Kept, so a second writer before the save gets the same ops again.
            this.unsaved = unsaved;
            this.scheduleSave();
            this.options.onChange({
                path: this.path,
                revision: this.project.revision,
                by: latest.updatedBy ?? "agent",
            });
        } catch (error) {
            this.project = disk;
            this.options.onChange({ path: this.path, revision: disk.revision, by });
            const message = error instanceof Error ? error.message : String(error);
            throw stale(
                `${by} saved the edit (revision ${disk.revision}) and the changes not saved yet do not apply to it, so they were dropped: ${message}`
            );
        }
    }
}

/**
 * Runs `work` on the edit session of `editPath`, so every undo, redo and collapse keeps one set of rules: the resident
 * session when this process holds the edit (the recorder service's, for a window), saved at once afterwards; otherwise
 * a short-lived one that loads the file, runs `work`, saves (waiting while another process saves) and closes, also
 * when `work` failed after a change. `onChange` hears the short-lived session's changes once they are saved; a
 * resident session tells its own subscribers.
 */
export async function withEditSession<T>(
    editPath: string,
    work: (session: OwnedEdit) => Promise<T> | T,
    options: { onChange?: (change: ProjectChanged) => void } = {}
): Promise<T> {
    const resident = ownedEdit(editPath);

    if (resident) {
        const answer = await work(resident);
        resident.flush();
        return answer;
    }

    const changes: ProjectChanged[] = [];
    const session = await EditSession.open(editPath, { onChange: (change) => changes.push(change) });

    try {
        return await work(session);
    } finally {
        await session.save();
        session.close();

        for (const change of changes) {
            options.onChange?.(change);
        }
    }
}

/**
 * The open edit sessions of the recorder service, one per edit file, each held by the connections that opened it.
 * The service calls `closeAll` when its process exits, so a change never waits out its save delay into nothing.
 */
export class EditSessions {
    private readonly open = new Map<string, { session: EditSession; holders: number }>();
    private readonly opening = new Map<string, Promise<EditSession>>();

    constructor(private readonly options: { onChange: (change: ProjectChanged) => void; saveDelayMs?: number }) {}

    get size(): number {
        return this.open.size;
    }

    /** The session of an edit path, when one is open. */
    get(path: string): EditSession | undefined {
        return this.open.get(path)?.session;
    }

    /** Opens (or holds once more) the session of a recording's edit. */
    async hold(value: string): Promise<EditSession> {
        const path = editPathOf(value);
        const known = this.open.get(path);

        if (known) {
            known.holders++;
            return known.session;
        }

        const opening = this.opening.get(path) ?? EditSession.open(value, this.options);
        this.opening.set(path, opening);

        try {
            const session = await opening;
            const entry = this.open.get(path) ?? { session, holders: 0 };
            entry.holders++;
            this.open.set(path, entry);
            return entry.session;
        } finally {
            this.opening.delete(path);
        }
    }

    /** Lets go of one hold; the last one saves and closes the session. */
    release(path: string): void {
        const entry = this.open.get(path);

        if (!entry) {
            return;
        }

        entry.holders--;

        if (entry.holders <= 0) {
            this.closeWhenFree(path, Date.now() + 10_000);
        }
    }

    private closeWhenFree(path: string, deadline: number): void {
        const entry = this.open.get(path);
        if (!entry || entry.holders > 0) {
            return;
        }
        try {
            entry.session.close();
            this.open.delete(path);
        } catch (error) {
            if (isArbitrationBusy(error) && Date.now() < deadline) {
                setTimeout(() => this.closeWhenFree(path, deadline), 100);
                return;
            }
            log.warn({ error, path }, "last save refused; the edit session is retained for recovery");
        }
    }

    /** Saves every session now (a render must see what the window shows); a refused save is logged. */
    flushAll(): void {
        for (const { session } of this.open.values()) {
            try {
                session.flush();
            } catch (error) {
                log.warn({ error, path: session.path }, "an edit session's save was refused");
            }
        }
    }

    closeAll(): void {
        for (const [path] of this.open) {
            const entry = this.open.get(path);
            if (entry) {
                entry.holders = 0;
            }
            this.closeWhenFree(path, Date.now() + 10_000);
        }
    }
}
