import { logger } from "@genesiscz/utils/logger";
import { localTime } from "@genesiscz/utils/transcribe/render";
import { type DisplayEntry, type DisplayMode, type DisplaySelection, RPC_ERRORS, RpcError } from "./control";
import type { DisplayBook } from "./display-book";
import type { LiveEntryChange, LiveEvent } from "./live";
import type { PieceCaptures } from "./session";
import { displayTarget, type PieceTarget, pickDisplayIds, pieceTargets } from "./targets";
import { CaptureError, type DisplayInfo, type FrameRecorder } from "./types";

const { log } = logger.scoped("screen-recorder-displays");

/**
 * Which displays a recording records, and how the display calls change that while it runs. Two kinds, one class each,
 * because their rules differ on purpose: `PolicyDisplays` (the meetings recorder) re-reads the connected displays for
 * every piece, follows a policy, and changes the running piece as little as it can; `ChosenDisplays` (the library
 * recording) records a fixed list of ids and restarts the piece on every change.
 */
/** What a display choice uses of the recording it serves (`FrameRecording`). */
export interface DisplayHost {
    readonly recorder: FrameRecorder;
    readonly displayBook: DisplayBook;
    readonly captures: PieceCaptures;
    readonly paused: boolean;
    emit(event: LiveEvent, params: Record<string, unknown>): void;
    update(change: LiveEntryChange): void;
    /** Throws while the recording stops, for a kind that refuses changes then. */
    refuseWhileStopping(): void;
    /** Moves the running capture onto another display in place; `none` when none can, `ended` when it ended meanwhile. */
    switchLive(target: PieceTarget): Promise<"live" | "ended" | "none">;
}

export interface DisplayChoice {
    /** The captures of the next piece; a throw is the piece's error. */
    targets(recording: DisplayHost): Promise<PieceTarget[]> | PieceTarget[];
    list(recording: DisplayHost): Promise<DisplayEntry[]>;
    add(recording: DisplayHost, displayId: number): Promise<DisplaySelection>;
    remove(recording: DisplayHost, displayId: number): Promise<DisplaySelection>;
    switchTo(recording: DisplayHost, displayId: number): Promise<DisplaySelection>;
    mode(recording: DisplayHost, mode: DisplayMode): Promise<DisplaySelection>;
}

type Applied = DisplaySelection["applied"];

async function connected(recording: DisplayHost, displayId: number): Promise<DisplayInfo> {
    const display = (await recording.recorder.displays()).find((one) => one.id === displayId);

    if (!display) {
        throw new RpcError(RPC_ERRORS.unknownDisplay, `display ${displayId} is not connected`);
    }

    return display;
}

/**
 * The meetings recorder's displays: the policy (`all`, `main`, `follow-focus`, an index) or the ids chosen over the
 * socket, read against the connected displays for each piece. A display that is missing falls back to the main one,
 * and `note` says so. An added display joins the running piece, a removed one ends only its own capture.
 */
export class PolicyDisplays implements DisplayChoice {
    /** The displays chosen by id over the socket; undefined while the policy decides. */
    chosen?: number[];
    private lastConnected = "";

    constructor(
        public policy: DisplayMode,
        private readonly options: {
            /** A display the policy asked for is missing, or the recorder cannot do what it asks. */
            note: (text: string) => void;
            /** `displays.mode` changed the policy. */
            onPolicy?: (policy: DisplayMode) => void;
        }
    ) {}

    async targets(recording: DisplayHost): Promise<PieceTarget[]> {
        const { recorder } = recording;
        const displays = await recorder.displays();
        const { targets, fallback } = pieceTargets({
            policy: this.policy,
            displays,
            followFocus: recorder.supports.followFocus,
            chosen: this.chosen,
            parallel: recorder.supports.parallelCaptures,
        });
        const connectedIds = displays.map((display) => display.id).join(",");

        if (connectedIds !== this.lastConnected) {
            const before = new Set(this.lastConnected.split(",").filter(Boolean).map(Number));
            const now = new Set(displays.map((display) => display.id));
            recording.emit("displays", {
                connected: displays.map((display) => ({ id: display.id, name: display.name })),
                removed: [...before].filter((id) => !now.has(id)),
            });
            this.lastConnected = connectedIds;
        }

        if (fallback) {
            this.options.note(`${fallback} (since ${localTime(new Date().toISOString())})`);
        }

        recording.displayBook.see(displays);

        if (targets.length === 0) {
            throw new CaptureError("display-missing", "no display is connected");
        }

        return targets;
    }

    async list(recording: DisplayHost): Promise<DisplayEntry[]> {
        const recordedIds = new Set(recording.displayBook.recorded?.map((display) => display.id) ?? []);
        return (await recording.recorder.displays()).map((display) => ({
            ...display,
            recorded: recordedIds.has(display.id),
        }));
    }

    async add(recording: DisplayHost, displayId: number): Promise<DisplaySelection> {
        const display = await connected(recording, displayId);
        recording.refuseWhileStopping();

        if (!recording.recorder.supports.parallelCaptures) {
            throw new RpcError(
                RPC_ERRORS.invalidParams,
                `the ${recording.recorder.id} recorder records one display at a time; use displays.switch`
            );
        }

        this.chosen = [...new Set([...this.currentIds(recording), display.id])];

        if (!recording.captures.inPiece || recording.paused || recording.captures.running.has(display.id)) {
            return this.answer("next-piece");
        }

        recording.captures.start(displayTarget(display));
        return this.answer("started");
    }

    async remove(recording: DisplayHost, displayId: number): Promise<DisplaySelection> {
        const current = this.currentIds(recording);

        if (!current.includes(displayId)) {
            throw new RpcError(RPC_ERRORS.unknownDisplay, `display ${displayId} is not being recorded`);
        }

        if (current.length === 1) {
            throw new RpcError(
                RPC_ERRORS.lastDisplay,
                "the last recorded display cannot be removed; pause or stop instead"
            );
        }

        recording.refuseWhileStopping();
        this.chosen = current.filter((id) => id !== displayId);
        const capture = recording.captures.running.get(displayId);

        if (!capture) {
            return this.answer("next-piece");
        }

        // The capture that records the sound restarts the piece, so another capture takes the sound.
        if (capture.audio) {
            return this.restart(recording, () => undefined);
        }

        capture.controller.abort();
        return this.answer("stopped");
    }

    async switchTo(recording: DisplayHost, displayId: number): Promise<DisplaySelection> {
        const display = await connected(recording, displayId);
        recording.refuseWhileStopping();
        const switched = await recording.switchLive(displayTarget(display));

        if (switched === "none") {
            return this.restart(recording, () => {
                this.chosen = [display.id];
            });
        }

        this.chosen = [display.id];
        // The capture may have ended while the switch was in flight; the next piece records the display.
        return this.answer(switched === "live" ? "live" : "next-piece");
    }

    async mode(recording: DisplayHost, mode: DisplayMode): Promise<DisplaySelection> {
        return this.restart(recording, () => {
            this.policy = mode;
            this.chosen = undefined;
            this.options.onPolicy?.(mode);
        });
    }

    private currentIds(recording: DisplayHost): number[] {
        return this.chosen ?? recording.displayBook.recorded?.map((one) => one.id) ?? [];
    }

    private answer(applied: Applied): DisplaySelection {
        return { mode: this.policy, chosen: this.chosen ?? null, applied };
    }

    /** A change no running capture can take: the running piece ends and the next starts with the new set at once. */
    private restart(recording: DisplayHost, change: () => void): DisplaySelection {
        recording.refuseWhileStopping();
        change();
        log.info(
            { policy: this.policy, chosen: this.chosen },
            "recorded displays chosen over the socket; the piece restarts"
        );
        recording.captures.abortAll();
        return this.answer("restart");
    }
}

/**
 * The library recording's displays: a fixed list of ids (`main`, `all`, ids, an index; `follow-focus` records every
 * display), resolved when it is chosen. An unknown id is refused, and every change restarts the running piece.
 */
export class ChosenDisplays implements DisplayChoice {
    chosen: number[] = [];
    /** The displays as the recorder listed them last. */
    known: DisplayInfo[] = [];

    /**
     * The ids a mode or a list means for the known displays. More than one is refused when the recorder records one
     * display at a time, so a start or a change asks for one display instead of losing the others silently.
     */
    pick(mode: DisplayMode | number[], recorder: FrameRecorder): number[] {
        const ids = pickDisplayIds(mode, this.known);

        if (ids.length > 1 && !recorder.supports.parallelCaptures) {
            throw new RpcError(
                RPC_ERRORS.unsupported,
                "this recorder records one display at a time; select one display"
            );
        }

        return ids;
    }

    /** The chosen displays with their names, for the live entry and the manifest. */
    recorded(): Array<{ id: number; name: string }> {
        return this.chosen.map((id) => ({
            id,
            name: this.known.find((one) => one.id === id)?.name ?? `display ${id}`,
        }));
    }

    targets(recording: DisplayHost): PieceTarget[] {
        const ids = recording.recorder.supports.parallelCaptures ? this.chosen : this.chosen.slice(0, 1);
        return ids.map((displayId) => this.targetOf(displayId));
    }

    async list(recording: DisplayHost): Promise<DisplayEntry[]> {
        this.known = await recording.recorder.displays();
        return this.known.map((display) => ({ ...display, recorded: this.chosen.includes(display.id) }));
    }

    async add(recording: DisplayHost, displayId: number): Promise<DisplaySelection> {
        return this.choose(recording, this.pick([...this.chosen, displayId], recording.recorder));
    }

    async remove(recording: DisplayHost, displayId: number): Promise<DisplaySelection> {
        const next = this.chosen.filter((id) => id !== displayId);

        if (next.length === 0) {
            throw new RpcError(RPC_ERRORS.lastDisplay, "the recording keeps at least one display");
        }

        return this.choose(recording, next);
    }

    async switchTo(recording: DisplayHost, displayId: number): Promise<DisplaySelection> {
        const [to] = this.pick([displayId], recording.recorder);
        const switched = await recording.switchLive(this.targetOf(to));

        if (switched !== "live") {
            return this.choose(recording, [to]);
        }

        this.chosen = [to];
        recording.update({ displays: this.recorded() });
        return { mode: "all", chosen: [to], applied: "live" };
    }

    async mode(recording: DisplayHost, mode: DisplayMode): Promise<DisplaySelection> {
        return { ...this.choose(recording, this.pick(mode, recording.recorder)), mode };
    }

    private targetOf(displayId: number): PieceTarget {
        const display = this.known.find((one) => one.id === displayId);
        return display
            ? displayTarget(display)
            : { target: { kind: "display", displayId }, displayId, label: `display ${displayId}` };
    }

    private choose(recording: DisplayHost, next: number[]): DisplaySelection {
        recording.refuseWhileStopping();
        this.chosen = next;
        recording.update({ displays: this.recorded() });
        recording.captures.abortAll();
        return { mode: "all", chosen: next, applied: "restart" };
    }
}
