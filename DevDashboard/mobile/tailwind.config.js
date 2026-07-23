/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ["./src/app/**/*.{js,jsx,ts,tsx}", "./src/components/**/*.{js,jsx,ts,tsx}", "./src/ui/**/*.{js,jsx,ts,tsx}"],
    presets: [require("nativewind/preset")],
    theme: {
        extend: {
            // Ported from the web dashboard's `--dd-*` token set
            // (src/dev-dashboard/ui/src/slate-grid.css), dark-only ("Obsidian Terminal").
            // Concrete hex, NOT `var(--dd-*)`: NativeWind v4's RN runtime does not resolve
            // `:root` CSS variables from an imported stylesheet (that is the web pattern; on
            // native you must register them via `vars()`/`addBase`), so `bg-dd-*` classes fell
            // back to transparent/white. These values mirror `src/theme/colors.ts` (the Skia
            // resolver) 1:1 — keep the two in sync. Token NAMES stay identical so the later
            // NativeWind v5 (`@theme`) migration is still config-only.
            colors: {
                dd: {
                    "bg-base": "#0c0e10",
                    "bg-panel": "#101316",
                    border: "#1e2428",
                    grid: "rgba(52, 211, 153, 0.04)",
                    "accent-from": "#34d399",
                    "accent-to": "#2dd4bf",
                    "accent-glow": "rgba(52, 211, 153, 0.35)",
                    "text-primary": "#e6edf3",
                    "text-secondary": "#8b96a0",
                    "text-muted": "#5b6670",
                    danger: "#f87171",
                },
            },
        },
    },
    plugins: [],
};
