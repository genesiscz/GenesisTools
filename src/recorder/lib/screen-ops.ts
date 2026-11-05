import { type EditOp, editOpSchema } from "@genesiscz/utils/recording-editor/project";
import type { ScreenBox, ScreenHit } from "./screen-search";

/**
 * What a found screen box can become, as edit ops for `apply` (the REPL's `apply({ ops })`, `tools recorder apply`,
 * the editor's Find tab): `hide[i]` blurs `boxes[i]` and `mark[i]` draws a box round it while the frame shows, and
 * `cut` removes only the frame's time. Hide and mark continue through each line's visible run.
 * Empty when the movie does not show the frame (no boxes, nothing to cut) or the frame
 * starts past the movie's end.
 */
export interface ScreenHitOps {
    hide: EditOp[];
    mark: EditOp[];
    cut: EditOp[];
}

export type ScreenHitWithOps = ScreenHit & { ops: ScreenHitOps };

/** A blur reaches a little past the OCR line, so it covers the letters' edges. */
const HIDE_PAD = 0.004;
/** A drawn box sits a little further out, so its stroke does not cross the letters. */
const MARK_PAD = 0.008;

/** The box grown by `pad` on every side, kept inside the picture (fractions from its top left). */
function grown(box: ScreenBox, pad: number): { x: number; y: number; width: number; height: number } {
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    return { x, y, width: Math.min(1 - x, box.width + 2 * pad), height: Math.min(1 - y, box.height + 2 * pad) };
}

/** The ops of one hit, over its frame's time cut at `durationSec` (the movie's source length), when known. */
export function screenHitOps(hit: ScreenHit, durationSec?: number): ScreenHitOps {
    const to = durationSec === undefined ? hit.untilSec : Math.min(hit.untilSec, durationSec);

    if (!hit.shown || !(to > hit.sec)) {
        return { hide: [], mark: [], cut: [] };
    }

    const span = { from: hit.sec, to };
    const hide = hit.boxes.map((box) =>
        editOpSchema.parse({
            op: "redact",
            ...span,
            to: Math.min(box.untilSec ?? hit.untilSec, durationSec ?? Infinity),
            rect: grown(box, HIDE_PAD),
            style: "blur",
            label: box.text.slice(0, 60),
        })
    );
    const mark = hit.boxes.map((box) => {
        const rect = grown(box, MARK_PAD);
        return editOpSchema.parse({
            op: "shape",
            kind: "box",
            ...span,
            to: Math.min(box.untilSec ?? hit.untilSec, durationSec ?? Infinity),
            start: { x: rect.x, y: rect.y },
            end: { x: rect.x + rect.width, y: rect.y + rect.height },
        });
    });
    return { hide, mark, cut: [editOpSchema.parse({ op: "cut", ...span })] };
}

/** Each hit with the ops that hide, mark or cut it, as the REPL's findOnScreen and `find-screen --json` answer. */
export function screenHitsWithOps(hits: readonly ScreenHit[], durationSec?: number): ScreenHitWithOps[] {
    return hits.map((hit) => ({ ...hit, ops: screenHitOps(hit, durationSec) }));
}
