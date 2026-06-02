import {
    Activity,
    BookOpen,
    Brain,
    CircleCheck,
    Droplets,
    Dumbbell,
    Heart,
    type LucideIcon,
    Moon,
    Music,
    PenLine,
    Sparkles,
    Sun,
} from "lucide-react";

/**
 * Curated, typed color catalog. Each color carries the Tailwind classes the
 * card/heatmap need so we never index over the full palette dynamically.
 * `heatmapLevels` are background classes for emptyish→full intensity (level 0
 * is the muted track, handled by the heatmap component).
 */
export interface HabitColor {
    id: string;
    label: string;
    /** Solid swatch / accent (icon, ring). */
    accent: string;
    /** Text accent for streak/progress. */
    text: string;
    /** Border tint for the active card outline. */
    border: string;
    /** Soft glow shadow on hover. */
    glow: string;
    /** Heatmap fill classes for levels 1..4 (level 0 = track, not here). */
    heatmapLevels: [string, string, string, string];
}

export const HABIT_COLORS: HabitColor[] = [
    {
        id: "emerald",
        label: "Emerald",
        accent: "bg-emerald-500",
        text: "text-emerald-400",
        border: "border-emerald-500/40",
        glow: "hover:shadow-[0_8px_32px_-8px_rgba(16,185,129,0.3)]",
        heatmapLevels: ["bg-emerald-500/30", "bg-emerald-500/55", "bg-emerald-500/80", "bg-emerald-400"],
    },
    {
        id: "sky",
        label: "Sky",
        accent: "bg-sky-500",
        text: "text-sky-400",
        border: "border-sky-500/40",
        glow: "hover:shadow-[0_8px_32px_-8px_rgba(14,165,233,0.3)]",
        heatmapLevels: ["bg-sky-500/30", "bg-sky-500/55", "bg-sky-500/80", "bg-sky-400"],
    },
    {
        id: "violet",
        label: "Violet",
        accent: "bg-violet-500",
        text: "text-violet-400",
        border: "border-violet-500/40",
        glow: "hover:shadow-[0_8px_32px_-8px_rgba(139,92,246,0.3)]",
        heatmapLevels: ["bg-violet-500/30", "bg-violet-500/55", "bg-violet-500/80", "bg-violet-400"],
    },
    {
        id: "amber",
        label: "Amber",
        accent: "bg-amber-500",
        text: "text-amber-400",
        border: "border-amber-500/40",
        glow: "hover:shadow-[0_8px_32px_-8px_rgba(245,158,11,0.3)]",
        heatmapLevels: ["bg-amber-500/30", "bg-amber-500/55", "bg-amber-500/80", "bg-amber-400"],
    },
    {
        id: "rose",
        label: "Rose",
        accent: "bg-rose-500",
        text: "text-rose-400",
        border: "border-rose-500/40",
        glow: "hover:shadow-[0_8px_32px_-8px_rgba(244,63,94,0.3)]",
        heatmapLevels: ["bg-rose-500/30", "bg-rose-500/55", "bg-rose-500/80", "bg-rose-400"],
    },
    {
        id: "cyan",
        label: "Cyan",
        accent: "bg-cyan-500",
        text: "text-cyan-400",
        border: "border-cyan-500/40",
        glow: "hover:shadow-[0_8px_32px_-8px_rgba(6,182,212,0.3)]",
        heatmapLevels: ["bg-cyan-500/30", "bg-cyan-500/55", "bg-cyan-500/80", "bg-cyan-400"],
    },
];

const DEFAULT_COLOR = HABIT_COLORS[0];

export function getHabitColor(id: string): HabitColor {
    return HABIT_COLORS.find((c) => c.id === id) ?? DEFAULT_COLOR;
}

/** Curated icon catalog — small typed map, no dynamic lucide indexing. */
export interface HabitIcon {
    id: string;
    label: string;
    Icon: LucideIcon;
}

export const HABIT_ICONS: HabitIcon[] = [
    { id: "CircleCheck", label: "Check", Icon: CircleCheck },
    { id: "Dumbbell", label: "Workout", Icon: Dumbbell },
    { id: "BookOpen", label: "Read", Icon: BookOpen },
    { id: "Droplets", label: "Hydrate", Icon: Droplets },
    { id: "Brain", label: "Focus", Icon: Brain },
    { id: "Moon", label: "Sleep", Icon: Moon },
    { id: "Sun", label: "Morning", Icon: Sun },
    { id: "Heart", label: "Health", Icon: Heart },
    { id: "PenLine", label: "Write", Icon: PenLine },
    { id: "Music", label: "Music", Icon: Music },
    { id: "Activity", label: "Move", Icon: Activity },
    { id: "Sparkles", label: "Mindful", Icon: Sparkles },
];

const DEFAULT_ICON = HABIT_ICONS[0];

export function getHabitIcon(id: string): LucideIcon {
    return (HABIT_ICONS.find((i) => i.id === id) ?? DEFAULT_ICON).Icon;
}

/** Map a per-day count to an intensity level 0..4. */
export function countToLevel(count: number): number {
    if (count <= 0) {
        return 0;
    }
    if (count === 1) {
        return 1;
    }
    if (count <= 3) {
        return 2;
    }
    if (count <= 5) {
        return 3;
    }
    return 4;
}
