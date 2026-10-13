import type { CdpLike } from "@genesiscz/utils/chrome-devtools/cdp-like";
import type { CdpEventListener, Page } from "./cdp.ts";

/**
 * Wraps a GenesisTools `Page` as the `CdpLike` session the `@genesiscz/utils/chrome-devtools` helpers take.
 * `on`/`off` filter the page's single event stream down to one event name.
 */
export function cdpLikeOf(page: Pick<Page, "send" | "on" | "off">): CdpLike {
    const wrapped = new Map<string, Map<(params: unknown) => void, CdpEventListener>>();
    return {
        send(method, params, options) {
            return page.send(method, params, options);
        },
        on(event, listener) {
            const forEvent = wrapped.get(event) ?? new Map<(params: unknown) => void, CdpEventListener>();
            wrapped.set(event, forEvent);
            if (forEvent.has(listener)) {
                return;
            }

            const filtered: CdpEventListener = (method, params) => {
                if (method === event) {
                    listener(params);
                }
            };
            forEvent.set(listener, filtered);
            page.on(filtered);
        },
        off(event, listener) {
            const filtered = wrapped.get(event)?.get(listener);
            if (filtered) {
                page.off(filtered);
                wrapped.get(event)?.delete(listener);
            }
        },
    };
}
