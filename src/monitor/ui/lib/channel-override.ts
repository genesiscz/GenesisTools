import { isSecretMarker } from "@app/monitor/lib/types";
import type { ChannelDraft } from "@app/monitor/ui/components/channel-fields";

/**
 * The monitor-app override to PATCH for one channel.
 *
 * Only the fields the user actually edited go in. The draft is seeded from
 * `view.resolved`, which is the GLOBAL config merged with the app override, so
 * copying every non-empty draft value pinned inherited values as monitor
 * overrides: later edits in `tools notify config` stopped reaching monitor and
 * the "monitor override" badge lit up for fields nobody had touched.
 *
 * An emptied string field is kept, not skipped: the API reads `""` as "stop
 * overriding this key" (`notify-settings.ts`, empty string -> undefined -> the
 * key is deleted), and this UI is the only place that clear is reachable from.
 */
export function buildChannelOverride(draft: ChannelDraft, touched: Iterable<string>): Record<string, string | boolean> {
    const override: Record<string, string | boolean> = {};

    for (const key of touched) {
        // `botTokenSet` and friends are the masked read-only markers the view
        // carries in place of a secret; they are not writable fields.
        if (isSecretMarker(key)) {
            continue;
        }

        const value = draft[key];

        if (typeof value === "string" || typeof value === "boolean") {
            override[key] = value;
        }
    }

    return override;
}
