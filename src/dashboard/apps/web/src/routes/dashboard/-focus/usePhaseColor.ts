import type { PomodoroPhase } from "@dashboard/shared";

export interface PhaseColor {
    /** Tailwind accent class fragment, e.g. "amber-500" */
    accent: string;
    /** Right ambient orb full class */
    orbRight: string;
    /** Left ambient orb full class */
    orbLeft: string;
    /** Base scanline opacity (before elapsed-ratio modulation) */
    scanlineBase: number;
    /** Gradient-text bg-gradient class */
    gradientClass: string;
    /** Sticky header border class */
    headerBorder: string;
    /** Text-shadow color as RGB triplet for inline style */
    glowRgb: string;
    /** Text color class for the accent */
    textClass: string;
}

const palette: Record<PomodoroPhase, PhaseColor> = {
    work: {
        accent: "amber-500",
        orbRight: "bg-amber-500/15",
        orbLeft: "bg-rose-500/10",
        scanlineBase: 0.1,
        gradientClass: "bg-gradient-to-r from-amber-400 via-amber-200 to-amber-400",
        headerBorder: "border-amber-500/20",
        glowRgb: "245 158 11",
        textClass: "text-amber-500",
    },
    short_break: {
        accent: "emerald-400",
        orbRight: "bg-emerald-500/15",
        orbLeft: "bg-cyan-500/10",
        scanlineBase: 0.1,
        gradientClass: "bg-gradient-to-r from-emerald-300 via-emerald-100 to-emerald-300",
        headerBorder: "border-emerald-400/20",
        glowRgb: "52 211 153",
        textClass: "text-emerald-400",
    },
    long_break: {
        accent: "cyan-400",
        orbRight: "bg-cyan-500/15",
        orbLeft: "bg-purple-500/10",
        scanlineBase: 0.05,
        gradientClass: "bg-gradient-to-r from-cyan-300 via-cyan-100 to-cyan-300",
        headerBorder: "border-cyan-400/20",
        glowRgb: "34 211 238",
        textClass: "text-cyan-400",
    },
};

export function usePhaseColor(phase: PomodoroPhase): PhaseColor {
    return palette[phase];
}
