import { createLiveHub, type LiveHub } from "@app/dev-dashboard/lib/live/hub";

let hub: LiveHub | null = null;

export function getLiveHub(): LiveHub {
    if (!hub) {
        hub = createLiveHub();
    }

    return hub;
}

/** Test-only. */
export function _resetLiveHub(): void {
    hub?._reset();
    hub = null;
}
