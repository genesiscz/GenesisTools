import { z } from "zod";
import type { ChangeStep } from "./waits";

/**
 * What happens on screen, so an effect is placed on it instead of on a guessed second: scene changes (most of the
 * picture changes at once), scroll stretches (the content moves up or down), still stretches (nothing changes), and
 * clicks (the cursor track) or taps (a log the caller passes, for a movie without one, such as a simulator).
 * Times are SOURCE microseconds, from the picture's change steps (waits.ts) at their rate.
 */
export const MOVIE_EVENT_KINDS = ["scene", "scroll", "still", "click", "tap"] as const;
export type MovieEventKind = (typeof MOVIE_EVENT_KINDS)[number];

export interface MovieEvent {
    kind: MovieEventKind;
    /** The event's place among the events of its kind, from 1. */
    index: number;
    fromUs: number;
    /** The end of a stretch (scroll, still); a scene change, click or tap is a moment. */
    toUs?: number;
    /** A scroll: the content moved this share of the picture's height, down positive. */
    shift?: number;
    /** A click or tap: where, as fractions of the picture from its top left. */
    x?: number;
    y?: number;
}

/** A scene change: at least this share of the picture changes in one step. */
const SCENE_SHARE = 0.45;
/** A still stretch lasts at least this long. */
const STILL_MIN_US = 1_000_000;
/** Scroll steps this close together are one scroll. */
const SCROLL_GAP_US = 500_000;

export const tapSchema = z.object({
    at: z.number().nonnegative(),
    x: z.number().min(0).max(1).optional(),
    y: z.number().min(0).max(1).optional(),
});
export type Tap = z.infer<typeof tapSchema>;

/** The events of a movie from its change steps (step `i` compares picture `i` with `i + 1`), clicks and taps. */
export function movieEvents(options: {
    steps: readonly ChangeStep[];
    fps: number;
    /** The compared pictures' height in pixels, which a step's `dy` counts in. */
    pictureHeight: number;
    clicks?: ReadonlyArray<{ ms: number; x: number; y: number }>;
    taps?: readonly Tap[];
}): MovieEvent[] {
    const stepUs = 1_000_000 / options.fps;
    const raw: Array<Omit<MovieEvent, "index">> = [];
    let still: number | undefined;
    let scroll: { fromUs: number; toUs: number; rows: number } | undefined;
    const closeScroll = () => {
        if (scroll) {
            raw.push({
                kind: "scroll",
                fromUs: scroll.fromUs,
                toUs: scroll.toUs,
                shift: Math.round((scroll.rows / Math.max(1, options.pictureHeight)) * 1000) / 1000,
            });
            scroll = undefined;
        }
    };

    for (let index = 0; index <= options.steps.length; index++) {
        const step = options.steps[index];
        const atUs = Math.round(index * stepUs);
        const quiet = step !== undefined && step.changed === 0;

        if (quiet && still === undefined) {
            still = atUs;
        } else if (!quiet && still !== undefined) {
            if (atUs - still >= STILL_MIN_US) {
                raw.push({ kind: "still", fromUs: still, toUs: atUs });
            }

            still = undefined;
        }

        if (!step) {
            continue;
        }

        if (step.dy) {
            if (scroll && atUs - scroll.toUs <= SCROLL_GAP_US) {
                scroll.toUs = atUs + Math.round(stepUs);
                scroll.rows += step.dy;
            } else {
                closeScroll();
                scroll = { fromUs: atUs, toUs: atUs + Math.round(stepUs), rows: step.dy };
            }
        } else if (step.changed / Math.max(1, step.cells) >= SCENE_SHARE) {
            // The picture changed at the end of this step: the next picture is the new scene.
            raw.push({ kind: "scene", fromUs: Math.round((index + 1) * stepUs) });
        }
    }

    closeScroll();

    for (const click of options.clicks ?? []) {
        raw.push({ kind: "click", fromUs: Math.round(click.ms * 1000), x: click.x, y: click.y });
    }

    for (const tap of options.taps ?? []) {
        raw.push({
            kind: "tap",
            fromUs: Math.round(tap.at * 1_000_000),
            ...(tap.x === undefined ? {} : { x: tap.x }),
            ...(tap.y === undefined ? {} : { y: tap.y }),
        });
    }

    const counts = new Map<MovieEventKind, number>();
    return raw
        .sort((a, b) => a.fromUs - b.fromUs)
        .map((event) => {
            const index = (counts.get(event.kind) ?? 0) + 1;
            counts.set(event.kind, index);
            return { ...event, index };
        });
}

/** An event anchor: the `index`th event of `event` (1 is the first; -1 the last), moved by `lead` seconds. */
export const eventAnchorSchema = z
    .object({
        event: z.enum(MOVIE_EVENT_KINDS),
        index: z
            .number()
            .int()
            .refine((value) => value !== 0, "index counts from 1, or from -1 at the end"),
        lead: z.number().min(-60).max(60).optional(),
        /** A stretch's end instead of its start. */
        end: z.boolean().optional(),
    })
    .strict();
export type EventAnchor = z.infer<typeof eventAnchorSchema>;

/** The source time an anchor names, in microseconds; refused with the count when there is no such event. */
export function anchorTimeUs(events: readonly MovieEvent[], anchor: EventAnchor): number {
    const ofKind = events.filter((event) => event.kind === anchor.event);
    const event = anchor.index > 0 ? ofKind[anchor.index - 1] : ofKind[ofKind.length + anchor.index];

    if (!event) {
        throw new RangeError(`there is no ${anchor.event} event ${anchor.index}; the movie has ${ofKind.length}`);
    }

    const base = anchor.end && event.toUs !== undefined ? event.toUs : event.fromUs;
    return Math.max(0, Math.round(base + (anchor.lead ?? 0) * 1_000_000));
}

/** The event nearest a source time (its start, or a stretch's end when that is nearer), of `kinds` when given. */
export function nearestEvent(
    events: readonly MovieEvent[],
    atUs: number,
    kinds?: readonly MovieEventKind[]
): { event: MovieEvent; atUs: number; edge: "start" | "end" } | undefined {
    let best: { event: MovieEvent; atUs: number; edge: "start" | "end" } | undefined;

    for (const event of events) {
        if (kinds && !kinds.includes(event.kind)) {
            continue;
        }

        for (const [edge, time] of [
            ["start", event.fromUs],
            ["end", event.toUs],
        ] as const) {
            if (time !== undefined && (!best || Math.abs(time - atUs) < Math.abs(best.atUs - atUs))) {
                best = { event, atUs: time, edge };
            }
        }
    }

    return best;
}
