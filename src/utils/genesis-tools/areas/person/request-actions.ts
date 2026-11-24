import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import { z } from "zod";

/** The words on a button the caller declares: short, as on any Mac button. */
export const requestButtonLabelSchema = z.string().trim().min(1).max(40);

/**
 * The extra buttons a request may declare, by kind. A click keeps the window open and answers nothing: the app runs
 * the kind itself from its typed fields, never a command line a caller wrote. A new kind is one schema here, its line in
 * `REQUEST_ACTION_LINES`, and one maker in the app's `RequestActions` table
 * (src/macos/GenesisTools/Sources/Host/RequestActions.swift).
 */
const REQUEST_ACTION_SCHEMAS = {
    /**
     * Plays a range of a meeting, the same cut `tools meetings play <meeting> --at --to` plays (the Moment, which needs
     * the meeting's transcript); with `track`, that original track of the range (`--track`). A second click stops it.
     */
    "play-meeting": z.object({
        kind: z.literal("play-meeting"),
        label: requestButtonLabelSchema,
        meeting: z.string().min(1).max(200),
        fromSec: z.number().nonnegative(),
        toSec: z.number().positive(),
        /** A `tools meetings play --track` kind (source-mic, mic-raw, …); the CLI refuses an unknown one. */
        track: z
            .string()
            .regex(/^[a-z][a-z-]*$/)
            .max(40)
            .optional(),
    }),
    /** Opens a web page (a genesis.tools router link opens its app). */
    "open-link": z.object({
        kind: z.literal("open-link"),
        label: requestButtonLabelSchema,
        url: z.url({ protocol: /^https?$/ }).max(2000),
    }),
};

export type RequestActionKind = keyof typeof REQUEST_ACTION_SCHEMAS;
type RequestActionOf<K extends RequestActionKind> = z.output<(typeof REQUEST_ACTION_SCHEMAS)[K]>;

export const requestActionSchema = z.discriminatedUnion("kind", [
    REQUEST_ACTION_SCHEMAS["play-meeting"],
    REQUEST_ACTION_SCHEMAS["open-link"],
]);
export type RequestAction = z.output<typeof requestActionSchema>;

/**
 * Each kind as one line for a surface that shows no buttons (the system dialog, a terminal): the command or the page a
 * person can use instead of the button.
 */
const REQUEST_ACTION_LINES: { [K in RequestActionKind]: (action: RequestActionOf<K>) => string } = {
    "play-meeting": (action) =>
        `${action.label}: ${toolCommand("meetings", "play", action.meeting, "--at", formatClock(action.fromSec), "--to", formatClock(Math.ceil(action.toSec)), ...(action.track ? ["--track", action.track] : []))}`,
    "open-link": (action) => `${action.label}: ${action.url}`,
};

/** The line a surface without buttons shows for `action`. */
export function requestActionLine<K extends RequestActionKind>(action: RequestActionOf<K> & { kind: K }): string {
    const line: (action: RequestActionOf<K>) => string = REQUEST_ACTION_LINES[action.kind];
    return line(action);
}
