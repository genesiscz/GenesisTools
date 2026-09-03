import { toast } from "sonner";

const TOAST_ID = "monitor-backend-down";

/** Fired on recovery so the app can refetch queries that errored while down. */
export const BACKEND_RECONNECTED_EVENT = "monitor:backend-reconnected";

let down = false;

/**
 * One persistent toast (stable id, so repeats refresh instead of stacking) so a
 * dead server never reads as "no watchers".
 */
export function reportBackendUnreachable(detail: string): void {
    down = true;
    toast.error("Monitor server unreachable", {
        id: TOAST_ID,
        description: `${detail}. Start it with: tools monitor server up`,
        duration: Number.POSITIVE_INFINITY,
    });
}

export function reportBackendReachable(): void {
    if (!down) {
        return;
    }

    down = false;
    toast.dismiss(TOAST_ID);
    toast.success("Monitor server reconnected");
    window.dispatchEvent(new Event(BACKEND_RECONNECTED_EVENT));
}
