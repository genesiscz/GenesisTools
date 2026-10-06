import type { SseFrame } from "@app/shops/ui/hooks/useSseStream";

export interface WatchlistNotificationPayload {
    id: number;
    favorite_id: number;
    title: string;
    body: string;
    detailUrl: string;
}

export function handleWatchlistNotificationBatch(
    batch: SseFrame[],
    callbacks: {
        invalidate: (queryKey: string[]) => void;
        notify: (payload: WatchlistNotificationPayload) => void;
    }
): void {
    let fired = false;
    for (const frame of batch) {
        if (frame.type !== "notification-fired") {
            continue;
        }

        fired = true;
        callbacks.notify(frame.data as WatchlistNotificationPayload);
    }

    if (fired) {
        callbacks.invalidate(["watchlist"]);
        callbacks.invalidate(["notifications", "unacked"]);
    }
}
