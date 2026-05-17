import type React from "react";
import { createContext, useContext, useMemo } from "react";

export type ThemeVariant = "default" | "nexus";

interface ThemeContextValue {
    variant: ThemeVariant;
}

const ThemeContext = createContext<ThemeContextValue>({ variant: "default" });

interface ThemeProviderProps {
    variant?: ThemeVariant;
    children: React.ReactNode;
}

export function ThemeProvider({ variant = "default", children }: ThemeProviderProps) {
    const value = useMemo<ThemeContextValue>(() => ({ variant }), [variant]);

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
    return useContext(ThemeContext);
}
