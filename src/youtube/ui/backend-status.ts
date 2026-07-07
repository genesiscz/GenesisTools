import { toast } from "sonner";

const TOAST_ID = "youtube-backend-down";

/** Fired on recovery so the app can refetch queries that errored while down. */
export const BACKEND_RECONNECTED_EVENT = "youtube:backend-reconnected";

let down = false;

/**
 * Surface "API server unreachable" as one persistent toast (stable id — repeated
 * reports refresh it instead of stacking) so a dead backend never looks like an
 * empty database again.
 */
export function reportBackendUnreachable(detail: string): void {
    down = true;
    toast.error("YouTube API server unreachable", {
        id: TOAST_ID,
        description: `${detail} — start it with: tools youtube server up`,
        duration: Number.POSITIVE_INFINITY,
    });
}

/** Clear the warning (and confirm recovery) once the backend responds again. */
export function reportBackendReachable(): void {
    if (!down) {
        return;
    }

    down = false;
    toast.dismiss(TOAST_ID);
    toast.success("YouTube API server reconnected");
    window.dispatchEvent(new Event(BACKEND_RECONNECTED_EVENT));
}
