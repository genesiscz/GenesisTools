import { existsSync, readFileSync } from "node:fs";
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
    computeEdit,
    editPathOf,
    inItsFolder,
    openProject,
    readUndoSteps,
    throwIfEditCancelled,
    type UndoStep,
    writeUndoSteps,
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
}

export interface EditAnswer {
    revision: number;
    project: EditProject;
    warnings?: string[];
    removedIdleUs?: Array<[number, number]>;
    loudness?: { measuredLufs: number | null; volume: number };
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
 * The one owner of a recording's edit.json while the recorder service runs. It reads the file once, applies ops in
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

    private constructor(
        readonly path: string,
        opened: { project: EditProject; fresh: boolean; text: string | null },
        private readonly options: { onChange: (change: ProjectChanged) => void; saveDelayMs: number }
    ) {
        this.project = opened.project;
        this.fresh = opened.fresh;
        this.diskText = opened.text;
        // The file's history continues here when it ends at this revision; otherwise undo refuses, as undoEdit does.
        const steps = readUndoSteps(path);
        this.undoSteps = steps.at(-1)?.afterRevision === opened.project.revision ? steps : [];
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
    apply(ops: readonly EditOp[], options: { by: string; baseRevision?: number }): Promise<EditAnswer> {
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
                return { revision: this.project.revision, project: this.project, ...extras };
            }

            this.change({
                next: edit.project,
                by: options.by,
                ops: ops.map((op) => op.op),
                unsaved: { kind: "ops", ops, facts: edit.facts },
            });
            return { revision: this.project.revision, project: this.project, ...extras };
        });
    }

    /** Puts the edit back as it was before its last change; the revision still rises. */
    undo(options: { by: string }): Promise<EditAnswer & { undone: string[] }> {
        return this.exclusive(async () => {
            this.syncWithDisk();
            const step = this.undoSteps.at(-1);

            if (!step) {
                throw new RpcError(RPC_ERRORS.nothingToUndo, "nothing to undo in this edit");
            }

            const undone = this.project;
            this.undoSteps.pop();
            this.redoSteps.push({ after: undone, ops: step.ops ?? [] });
            this.replace({ next: step.before, by: options.by, unsaved: { kind: "restore", what: "undo" } });
            // The step below now ends at this revision, so the next undo goes one step further back.
            const below = this.undoSteps.at(-1);

            if (below) {
                below.afterRevision = this.project.revision;
            }

            return { revision: this.project.revision, project: this.project, undone: step.ops ?? [] };
        });
    }

    /** Makes the last undone change again. */
    redo(options: { by: string }): Promise<EditAnswer & { redone: string[] }> {
        return this.exclusive(async () => {
            this.syncWithDisk();
            const step = this.redoSteps.pop();

            if (!step) {
                throw new RpcError(RPC_ERRORS.nothingToRedo, "nothing to redo in this edit");
            }

            const before = this.project;
            this.replace({ next: step.after, by: options.by, unsaved: { kind: "restore", what: "redo" } });
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
            writeUndoSteps(this.path, this.undoSteps);
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
    async commitGesture(id: string, options: { by: string }): Promise<EditAnswer> {
        const gesture = this.gestures.get(id);

        if (!gesture) {
            throw new RpcError(RPC_ERRORS.invalidParams, `no gesture ${id}; begin it first`);
        }

        while (gesture.running) {
            await gesture.running;
        }

        this.gestures.delete(id);

        if (!gesture.ops?.length) {
            return this.current;
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

    /** Saves now when a change waits for its save. Throws `staleRevision` when a newer file could not take it. */
    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }

        if (this.unsaved.length === 0) {
            return;
        }

        try {
            withPathArbitrationSync(this.path, () => {
                this.syncWithDisk();
    
                if (this.unsaved.length === 0) {
                    return;
                }
    
                this.diskText = saveAt(this.path, this.project);
                writeUndoSteps(this.path, this.undoSteps);
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
    private change({ next, by, ops, unsaved }: { next: EditProject; by: string; ops: string[]; unsaved: Unsaved }) {
        const before = this.project;
        this.replace({ next, by, unsaved });
        this.pushUndo({ before, afterRevision: this.project.revision, ops });
        this.redoSteps = [];
    }

    private closedError(): Error {
        return new Error(`the edit session of ${this.path} is closed`);
    }

    private replace({ next, by, unsaved }: { next: EditProject; by: string; unsaved: Unsaved }): void {
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
        this.options.onChange({ path: this.path, revision: this.project.revision, by });
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
     * once (with the measurements they had). The history before its change ends there, as undoEdit refuses then.
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
        if (!entry || entry.holders > 0) { return; }
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
        for (const [path, { session }] of this.open) {
            const entry = this.open.get(path);
            if (entry) { entry.holders = 0; }
            this.closeWhenFree(path, Date.now() + 10_000);
        }
    }
}
