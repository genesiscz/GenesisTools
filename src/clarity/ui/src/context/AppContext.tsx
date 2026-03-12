import { SafeJSON } from "@app/utils/json";
import { createContext, use, useCallback, useEffect, useState } from "react";

interface AppState {
    month: number;
    year: number;
}

interface AppContextValue {
    month: number;
    year: number;
    setMonth: (month: number) => void;
    setYear: (year: number) => void;
    setMonthYear: (month: number, year: number) => void;
}

const AppContext = createContext<AppContextValue | null>(null);
const APP_CONTEXT_STORAGE_KEY = "clarityAppContext.state";

function createDefaultState(): AppState {
    const now = new Date();

    return {
        month: now.getMonth() + 1,
        year: now.getFullYear(),
    };
}

function isValidMonthYear(month: unknown, year: unknown): boolean {
    return (
        typeof month === "number" &&
        typeof year === "number" &&
        month >= 1 &&
        month <= 12 &&
        year >= 1900 &&
        year <= 9999
    );
}

function readStoredState(defaultState: AppState): AppState {
    if (typeof window === "undefined") {
        return defaultState;
    }

    const raw = window.localStorage.getItem(APP_CONTEXT_STORAGE_KEY);

    if (!raw) {
        return defaultState;
    }

    try {
        const parsed = SafeJSON.parse(raw) as Partial<AppState> | null;

        if (typeof parsed !== "object" || parsed === null) {
            return defaultState;
        }

        if (!isValidMonthYear(parsed.month, parsed.year)) {
            return defaultState;
        }

        return {
            ...defaultState,
            ...parsed,
        };
    } catch {
        return defaultState;
    }
}

export function AppProvider({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<AppState>(() => {
        const defaultState = createDefaultState();
        return readStoredState(defaultState);
    });

    const persistState = useCallback((nextState: AppState): void => {
        if (typeof window === "undefined") {
            return;
        }

        window.localStorage.setItem(APP_CONTEXT_STORAGE_KEY, SafeJSON.stringify(nextState));
    }, []);

    const setMonthYear = (m: number, y: number): void => {
        setState((prev) => ({
            ...prev,
            month: m,
            year: y,
        }));
    };

    const setMonthOnly = (m: number): void => {
        setState((prev) => ({
            ...prev,
            month: m,
        }));
    };

    const setYearOnly = (y: number): void => {
        setState((prev) => ({
            ...prev,
            year: y,
        }));
    };

    useEffect(() => {
        persistState(state);
    }, [state, persistState]);

    return (
        <AppContext
            value={{
                month: state.month,
                year: state.year,
                setMonth: setMonthOnly,
                setYear: setYearOnly,
                setMonthYear,
            }}
        >
            {children}
        </AppContext>
    );
}

export function useAppContext(): AppContextValue {
    const ctx = use(AppContext);

    if (!ctx) {
        throw new Error("useAppContext must be used within AppProvider");
    }

    return ctx;
}
