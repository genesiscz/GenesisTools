import { SafeJSON } from "@genesiscz/utils/json";
import { useCallback, useEffect, useState } from "react";

// Same-tab localStorage writes do not emit a `storage` event (that is cross-tab
// only), so a second mounted consumer of the same key would only catch up on
// navigation. One custom event, carrying the key, keeps every consumer in sync
// within the tab. Same idiom as useLayoutMode, generalised to any JSON value.
const CHANGE_EVENT = "dd:persisted-change";

interface ChangeDetail {
    key: string;
}

export function readPersisted<T>(key: string, parse: (raw: unknown) => T | null): T | null {
    if (typeof window === "undefined") {
        return null;
    }

    const text = window.localStorage.getItem(key);

    if (text === null) {
        return null;
    }

    try {
        return parse(SafeJSON.parse(text, { strict: true }));
    } catch {
        // A hand-edited or pre-schema value: treat as absent, never crash the page.
        return null;
    }
}

export function writePersisted(key: string, value: unknown): void {
    if (typeof window === "undefined") {
        return;
    }

    window.localStorage.setItem(key, SafeJSON.stringify(value));
    window.dispatchEvent(new CustomEvent<ChangeDetail>(CHANGE_EVENT, { detail: { key } }));
}

export function clearPersisted(key: string): void {
    if (typeof window === "undefined") {
        return;
    }

    window.localStorage.removeItem(key);
    window.dispatchEvent(new CustomEvent<ChangeDetail>(CHANGE_EVENT, { detail: { key } }));
}

/**
 * `useState` backed by localStorage, synced across every consumer of `key` in
 * the tab. `parse` validates whatever is on disk and returns null for junk, so
 * the fallback wins over a stale shape.
 */
export function usePersistedState<T>(
    key: string,
    parse: (raw: unknown) => T | null,
    fallback: T
): [T, (next: T | ((prev: T) => T)) => void, () => void] {
    const [value, setValue] = useState<T>(() => readPersisted(key, parse) ?? fallback);

    const set = useCallback(
        (next: T | ((prev: T) => T)) => {
            setValue((prev) => {
                const resolved = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
                writePersisted(key, resolved);
                return resolved;
            });
        },
        [key]
    );

    const reset = useCallback(() => {
        clearPersisted(key);
        setValue(fallback);
    }, [key, fallback]);

    useEffect(() => {
        const sync = (event: Event) => {
            const detail = (event as CustomEvent<ChangeDetail>).detail;

            if (detail && detail.key !== key) {
                return;
            }

            setValue(readPersisted(key, parse) ?? fallback);
        };

        window.addEventListener(CHANGE_EVENT, sync);

        return () => window.removeEventListener(CHANGE_EVENT, sync);
    }, [key, parse, fallback]);

    return [value, set, reset];
}

/** Parser helper: an array of strings, or null. */
export function parseStringArray(raw: unknown): string[] | null {
    if (!Array.isArray(raw)) {
        return null;
    }

    if (!raw.every((item) => typeof item === "string")) {
        return null;
    }

    return raw;
}
