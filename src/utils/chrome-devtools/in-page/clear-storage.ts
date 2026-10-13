export interface ClearStorageArgs {
    /** localStorage keys to remove. */
    localStorage?: string[];
    /** sessionStorage keys to remove. */
    sessionStorage?: string[];
    /** Remove every localStorage key of the origin. */
    allLocal?: boolean;
    /** Remove every sessionStorage key of the origin. */
    allSession?: boolean;
    /**
     * Only in documents of these origins (`location.origin`). An init script also runs in frames and in pages a
     * redirect reaches (a login provider), so a reset meant for the app names the app's origins. Default: every document.
     */
    origins?: string[];
}

/**
 * Removes named Web Storage keys. Run it as an init script to reset state that would otherwise leak
 * between runs (a sampling decision kept in sessionStorage, a cached flag). Self-contained.
 */
export function clearStorageKeys(args: ClearStorageArgs): { removed: string[] } {
    const removed: string[] = [];
    if (args.origins && !args.origins.includes(location.origin)) {
        return { removed };
    }

    const clear = (area: "local" | "session", names: string[] | undefined, all: boolean | undefined): void => {
        try {
            const storage = area === "local" ? localStorage : sessionStorage;
            if (all) {
                for (let i = storage.length - 1; i >= 0; i--) {
                    removed.push(`${area}:${storage.key(i)}`);
                }

                storage.clear();
                return;
            }

            for (const name of names ?? []) {
                if (storage.getItem(name) !== null) {
                    storage.removeItem(name);
                    removed.push(`${area}:${name}`);
                }
            }
        } catch (error) {
            removed.push(`${area}:error ${String(error)}`);
        }
    };

    clear("local", args.localStorage, args.allLocal);
    clear("session", args.sessionStorage, args.allSession);
    return { removed };
}
