/**
 * The one place the dashboard decides WHOSE data it is looking at and over WHAT window.
 *
 * Every page reads its query params from here rather than owning its own profile picker, so
 * switching profile or year in the header re-renders the whole app against the new data.
 * The choice is persisted, because coming back to a dashboard pinned to last year's window
 * and not noticing is a good way to misread a number.
 */
import type { ProfileListReport, ProfileRow } from "@app/spotify/lib/reports/profiles";
import { fetchProfiles } from "@app/spotify/ui/lib/api";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger/client";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "spotify-dashboard-filters";

const log = logger.child({ component: "spotify:filters" });

export interface Filters {
    /** Profile name; empty means "whatever the registry calls default". */
    profile: string;
    /** A calendar year, or empty for the since/until pair (or all time). */
    year: string;
    since: string;
    until: string;
    /** Comparison partner for the two-person pages. */
    partner: string;
}

const EMPTY: Filters = { profile: "", year: "", since: "", until: "", partner: "" };

/** A patch, or a function of the current filters for callers that patch asynchronously. */
export type FilterPatch = Partial<Filters> | ((prev: Filters) => Partial<Filters>);

export interface FiltersContextValue {
    filters: Filters;
    setFilters: (patch: FilterPatch) => void;
    reset: () => void;
    /** Query params every report call passes through. */
    params: { profile?: string; year?: string; since?: string; until?: string };
    profiles: UseQueryResult<ProfileListReport, Error>;
    /** The profile actually in effect, resolved against the registry's default. */
    activeProfile: ProfileRow | null;
    windowLabel: string;
}

const FiltersContext = createContext<FiltersContextValue | null>(null);

function readStored(): Filters {
    if (typeof window === "undefined") {
        return EMPTY;
    }

    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);

        return raw ? { ...EMPTY, ...(SafeJSON.parse(raw) as Partial<Filters>) } : EMPTY;
    } catch (err) {
        // A corrupted or blocked localStorage must never stop the dashboard rendering, but a
        // silently ignored one is a debugging session nobody wanted.
        log.debug({ err }, "could not read the persisted filters");

        return EMPTY;
    }
}

export function describeWindow(f: Filters): string {
    if (f.year) {
        return f.year;
    }

    if (f.since && f.until) {
        return `${f.since} to ${f.until}`;
    }

    if (f.since) {
        return `since ${f.since}`;
    }

    if (f.until) {
        return `until ${f.until}`;
    }

    return "all time";
}

export function FiltersProvider({ children }: { children: ReactNode }) {
    const [filters, setState] = useState<Filters>(EMPTY);

    // Read persisted state after mount: SSR has no localStorage, and reading it during
    // render would make the server and client markup disagree.
    useEffect(() => {
        setState(readStored());
    }, []);

    const setFilters = useCallback((update: FilterPatch) => {
        setState((prev) => {
            // The functional form exists for callers that patch after an await: a patch computed
            // from a captured `filters` would put back whatever the user picked while the request
            // was in flight.
            const patch = typeof update === "function" ? update(prev) : update;
            // Year and an explicit range are mutually exclusive; setting one clears the other
            // so the header can never show a window the reports are not actually using.
            const next: Filters = { ...prev, ...patch };
            if (patch.year) {
                next.since = "";
                next.until = "";
            }

            if (patch.since !== undefined || patch.until !== undefined) {
                next.year = patch.year ?? "";
            }

            try {
                window.localStorage.setItem(STORAGE_KEY, SafeJSON.stringify(next));
            } catch (err) {
                // Private-mode browsers refuse writes; the filters still work for this session.
                log.debug({ err }, "could not persist the filters");
            }

            return next;
        });
    }, []);

    const reset = useCallback(() => {
        setState(EMPTY);
        try {
            window.localStorage.removeItem(STORAGE_KEY);
        } catch (err) {
            log.debug({ err }, "could not clear the persisted filters");
        }
    }, []);

    const profiles = useQuery({ queryKey: ["profiles"], queryFn: fetchProfiles, staleTime: 30_000 });

    const value = useMemo<FiltersContextValue>(() => {
        const rows = profiles.data?.profiles ?? [];
        const wanted = filters.profile || profiles.data?.defaultProfile || "";
        // Resolve the effective profile ONCE and send that same name with every request. A
        // persisted `filters.profile` naming a profile the registry no longer has would
        // otherwise show `rows[0]` in the header while every report asked for the stale one.
        const activeProfile = rows.find((p) => p.name === wanted) ?? rows[0] ?? null;

        return {
            filters,
            setFilters,
            reset,
            params: {
                profile: activeProfile?.name,
                year: filters.year || undefined,
                since: filters.since || undefined,
                until: filters.until || undefined,
            },
            profiles,
            activeProfile,
            windowLabel: describeWindow(filters),
        };
    }, [filters, setFilters, reset, profiles]);

    return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters(): FiltersContextValue {
    const ctx = useContext(FiltersContext);
    if (!ctx) {
        throw new Error("useFilters must be used inside <FiltersProvider>");
    }

    return ctx;
}
