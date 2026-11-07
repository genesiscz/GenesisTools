import { z } from "zod";

/**
 * The smooth cursor: the drawn cursor glides along an averaged curve instead of the recorded path. `strength` 0 to 1
 * widens the average up to ±400 ms; moves smaller than `jitterPx` points are dropped (a hand resting on the mouse);
 * after `idleFadeSeconds` without a move the cursor fades out (0 keeps it). The cursor still sits exactly on every
 * click. Absent is off: the cursor's own `smoothing` and `hideAfterMs` apply (EditRenderer.cursorMark).
 */
export const cursorSmoothSchema = z.object({
    strength: z.number().min(0).max(1).default(0.6),
    jitterPx: z.number().min(0).max(20).default(3),
    idleFadeSeconds: z.number().min(0).max(30).default(2),
});
export type EditCursorSmooth = z.infer<typeof cursorSmoothSchema>;
