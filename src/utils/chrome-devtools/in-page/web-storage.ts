export interface WebStorageArgs {
    /** Only these keys. Default: every key. */
    keys?: string[];
    /** Omit values longer than this many characters (a preview stays). Default: no cap. */
    maxValueChars?: number;
}

export interface WebStorageEntry {
    key: string;
    value?: string;
    chars: number;
    truncated?: boolean;
    preview?: string;
}

export interface WebStorageArea {
    entries: WebStorageEntry[];
    chars: number;
    error?: string;
}

export interface WebStorageDump {
    origin: string;
    local: WebStorageArea;
    session: WebStorageArea;
}

/** Reads localStorage and sessionStorage of the page's origin. Self-contained: only its source reaches the page. */
export function webStorageDump(args: WebStorageArgs): WebStorageDump {
    const read = (pick: () => Storage): WebStorageArea => {
        const area: WebStorageArea = { entries: [], chars: 0 };
        try {
            const storage = pick();
            const keys = args.keys ?? Array.from({ length: storage.length }, (_, i) => storage.key(i) ?? "");
            for (const key of keys) {
                const value = storage.getItem(key);
                if (value === null) {
                    continue;
                }

                area.chars += value.length;
                if (args.maxValueChars !== undefined && value.length > args.maxValueChars) {
                    area.entries.push({ key, chars: value.length, truncated: true, preview: value.slice(0, 200) });
                } else {
                    area.entries.push({ key, value, chars: value.length });
                }
            }
        } catch (error) {
            area.error = String(error);
        }

        return area;
    };

    return { origin: location.origin, local: read(() => localStorage), session: read(() => sessionStorage) };
}
