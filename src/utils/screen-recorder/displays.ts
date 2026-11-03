import { z } from "zod";
import type { DisplayInfo } from "./types";

const rawScreen = z.object({
    displayID: z.number().int().optional(),
    index: z.number().int(),
    name: z.string().default(""),
    isPrimary: z.boolean().default(false),
    scaleFactor: z.number().positive().default(1),
    resolution: z.object({ width: z.number(), height: z.number() }),
});
const screenList = z.object({ screens: z.array(rawScreen) });

/**
 * The displays of `ax-tool screens` (`{ok, screens}`) or `peekaboo screen list --json` (`{success, data: {screens}}`).
 * Both name each display's `displayID`; a list without it cannot be addressed by id and is refused.
 */
export function parseDisplayList(data: unknown): DisplayInfo[] {
    const envelope = z.object({ data: screenList }).safeParse(data);
    const parsed = envelope.success ? envelope.data.data : screenList.parse(data);

    return parsed.screens.map((screen) => {
        if (screen.displayID === undefined) {
            throw new Error(`display ${screen.index} has no displayID; update the capture tool`);
        }

        return {
            id: screen.displayID,
            index: screen.index,
            name: screen.name,
            main: screen.isPrimary,
            widthPt: screen.resolution.width,
            heightPt: screen.resolution.height,
            scale: screen.scaleFactor,
        };
    });
}

/** The output scale (pixels per point) that keeps the longer side of `display` at most `maxLongSidePx`. */
export function outputScaleFor(display: DisplayInfo, maxLongSidePx: number): number {
    const longSidePt = Math.max(display.widthPt, display.heightPt);
    return Math.min(display.scale, maxLongSidePx / longSidePt);
}

export function mainDisplay(displays: DisplayInfo[]): DisplayInfo | undefined {
    return displays.find((display) => display.main) ?? displays[0];
}
