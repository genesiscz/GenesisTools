import { createContext, use, useState } from "react";

interface AppContextValue {
    month: number;
    year: number;
    setMonth: (month: number) => void;
    setYear: (year: number) => void;
    setMonthYear: (month: number, year: number) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
    const now = new Date();
    const [month, setMonth] = useState(now.getMonth() + 1);
    const [year, setYear] = useState(now.getFullYear());

    const setMonthYear = (m: number, y: number) => {
        setMonth(m);
        setYear(y);
    };

    return <AppContext value={{ month, year, setMonth, setYear, setMonthYear }}>{children}</AppContext>;
}

export function useAppContext(): AppContextValue {
    const ctx = use(AppContext);

    if (!ctx) {
        throw new Error("useAppContext must be used within AppProvider");
    }

    return ctx;
}
