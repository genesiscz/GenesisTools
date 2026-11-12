// The local time each tool call started, drawn on its row under `[ask]`, or in its place while `[ask]` is off:
// `14:03:27 (5m ago)`. The `tool.call` hook notes the time as the call starts, into session state with one member
// per `tool_use_id`, so it survives a reload of the mod. A row from before the mod ran (a resumed session) has no
// time and draws none. The `ago` part counts wall-clock minutes (`liveWallAgo`), so every row changes at the same
// minute and the one live clock of `live.ts` redraws once a minute, however many rows show a time.
import type { EngineInterface } from "claude-code";
import { liveWallAgo } from "./live";
import { type Host, settingsOf } from "./shared";

/** The call `id` started at `at`; the first note wins, so a call keeps its start time. */
export async function noteCallTime($: EngineInterface, id: string | undefined, at = Date.now()): Promise<void> {
    if (id === undefined) {
        return;
    }

    const held = await $.state.get({ plugin: "genesis-tools-mods", key: "callAt", id });

    if (typeof held.value !== "number") {
        await $.state.set({ plugin: "genesis-tools-mods", key: "callAt", id }, at, { ifVersion: held.version });
    }
}

/** `14:03:27` in local time. */
export function clockOf(at: number): string {
    const date = new Date(at);

    return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** `14:03:27 (5m ago)`, or `14:03:27` without `ago`. */
export function callTimeText(at: number, options: { ago: boolean; now?: number }): string {
    return options.ago ? `${clockOf(at)} (${liveWallAgo(at, options.now)})` : clockOf(at);
}

/** The time line of a row: its first call with a noted start; undefined while the mod is off or none is noted. */
export async function callTimeOf(
    $: EngineInterface,
    host: Host,
    ids: readonly (string | undefined)[]
): Promise<string | undefined> {
    const settings = (await settingsOf(host)).toolTime;

    if (!settings.enabled) {
        return undefined;
    }

    for (const id of ids) {
        if (id === undefined) {
            continue;
        }

        const held = await $.state.get({ plugin: "genesis-tools-mods", key: "callAt", id }).catch(() => undefined);

        if (typeof held?.value === "number") {
            return callTimeText(held.value, { ago: settings.ago });
        }
    }

    return undefined;
}
