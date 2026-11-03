import { logger } from "@genesiscz/utils/logger";
import { type EventState, type ProviderEvent, providerById } from "./providers";

/** How often a wait for a recording asks the platform again. */
export const RECORDING_CHECK_INTERVAL_MS = 60_000;

/**
 * Asks the platform about the event, and with `waitMinutes`, asks again every minute while it is live or its recording
 * is not made yet, until a recording or an unavailable answer comes, the time is up, or the signal stops it.
 */
export async function awaitEventState({
    event,
    waitMinutes,
    signal,
    onWait,
}: {
    event: ProviderEvent;
    /** Undefined asks once. */
    waitMinutes?: number;
    signal?: AbortSignal;
    onWait?: (state: EventState, nextCheckAt: Date) => void;
}): Promise<EventState> {
    const provider = providerById(event.provider);
    const deadline = waitMinutes === undefined ? 0 : Date.now() + waitMinutes * 60_000;
    let state = await provider.check(event, signal);

    while ((state.kind === "live" || state.kind === "pending") && Date.now() < deadline && !signal?.aborted) {
        const delay = Math.min(RECORDING_CHECK_INTERVAL_MS, deadline - Date.now());
        onWait?.(state, new Date(Date.now() + delay));
        await sleep(delay, signal);

        if (signal?.aborted) {
            break;
        }

        try {
            state = await provider.check(event, signal);
        } catch (error) {
            if (signal?.aborted) {
                break;
            }

            // One failed check (a network blip) must not end a wait of hours; an expired session fails every time.
            logger.warn({ error, event: event.id }, "Recording check failed; trying again at the next interval");
        }
    }

    return state;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(done, ms);

        function done() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        }

        signal?.addEventListener("abort", done, { once: true });
    });
}

/** `<page>-<title>-<id>.mp4`, so two events of one page and two pages of one platform get two names. */
export function recordingOutputName(event: ProviderEvent): string {
    const slug = (text: string) =>
        text
            .replace(/^https?:\/\//i, "")
            .replace(/[^a-z0-9]+/gi, "-")
            .replace(/^-+|-+$/g, "");
    const parts = [
        event.page ? slug(event.page).slice(-60) : event.provider,
        slug(event.title ?? "").slice(0, 40),
        event.id,
    ];
    return `${parts.filter(Boolean).join("-")}.mp4`;
}

export function describeEvent(event: ProviderEvent): string {
    const title = event.title ? ` "${event.title}"` : "";
    return `${providerById(event.provider).name} event ${event.id}${title}`;
}
