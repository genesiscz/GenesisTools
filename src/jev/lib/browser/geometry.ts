import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { BrowserMcp } from "./session";

const prof = profiler.scope("jev-browser");
const { log } = logger.scoped("jev-browser");

const FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)\n?```/;

/**
 * `evaluate_script` answers with prose and a fenced JSON block:
 * "Script ran on page and returned:" then ```json\n"…"\n```. This reads the value back out.
 */
export function readScriptValue(text: string): unknown {
    const fenced = FENCE_RE.exec(text);
    const payload = fenced ? fenced[1].trim() : text.trim();
    if (!payload) {
        return undefined;
    }

    try {
        return SafeJSON.parse(payload, { strict: true });
    } catch (error) {
        log.debug({ error, payload: payload.slice(0, 120) }, "evaluate_script result was not JSON");
        return payload;
    }
}

export interface ScreenPoint {
    x: number;
    y: number;
}

const BOX_SCRIPT =
    "(el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height, window.screenX, window.screenY, window.innerHeight, window.outerHeight, window.innerWidth, window.outerWidth].join(','); }";

const MAX_SCREEN_COORDINATE = 100_000;

/**
 * The screen point at the centre of a snapshot node, for the cursor overlay.
 *
 * The page reports its own rectangle and the window's screen origin, so the point is real screen
 * geometry rather than the `(0, 0)` an earlier call site passed (the Swift guard rejected that, so
 * the overlay never drew). Returns undefined when the node has no box or the numbers are not
 * usable; the caller then skips the overlay instead of drawing somewhere wrong.
 */
export async function elementScreenCenter(options: { mcp: BrowserMcp; uid: string }): Promise<ScreenPoint | undefined> {
    const result = await prof.measureAsync("geometry", () =>
        options.mcp.callTool("evaluate_script", { function: BOX_SCRIPT, args: [options.uid] })
    );
    const value = readScriptValue(options.mcp.toolText(result));
    if (typeof value !== "string") {
        log.debug({ uid: options.uid, value }, "element box script returned no string");
        return undefined;
    }

    const numbers = value.split(",").map((part) => Number(part.trim()));
    if (numbers.length < 10 || numbers.some((entry) => !Number.isFinite(entry))) {
        log.debug({ uid: options.uid, value }, "element box script returned unusable numbers");
        return undefined;
    }

    const [rectX, rectY, width, height, screenX, screenY, innerHeight, outerHeight, innerWidth, outerWidth] = numbers;
    if (width <= 0 || height <= 0) {
        log.debug({ uid: options.uid, width, height }, "element has no visible box; skipping the overlay");
        return undefined;
    }

    const chromeHeight = Math.max(0, outerHeight - innerHeight);
    const sideBorder = Math.max(0, (outerWidth - innerWidth) / 2);
    const point = {
        x: screenX + sideBorder + rectX + width / 2,
        y: screenY + chromeHeight + rectY + height / 2,
    };
    if (Math.abs(point.x) > MAX_SCREEN_COORDINATE || Math.abs(point.y) > MAX_SCREEN_COORDINATE) {
        log.debug({ uid: options.uid, point }, "element screen point is off any plausible display");
        return undefined;
    }

    log.debug({ uid: options.uid, point, screenX, screenY, chromeHeight }, "element screen centre");
    return point;
}
