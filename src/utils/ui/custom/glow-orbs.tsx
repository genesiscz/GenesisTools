interface Orb {
    color: string;
    size: string;
    top?: string;
    left?: string;
    right?: string;
    opacity?: number;
}

const defaultOrbs: Orb[] = [
    { color: "#7c3aed", size: "600px", top: "-20%", left: "10%", opacity: 0.35 },
    { color: "#8b5cf6", size: "400px", top: "10%", right: "5%", opacity: 0.35 },
    { color: "#ec4899", size: "300px", top: "40%", right: "30%", opacity: 0.2 },
];

interface GlowOrbsProps {
    orbs?: Orb[];
}

export function GlowOrbs({ orbs = defaultOrbs }: GlowOrbsProps) {
    return (
        <div className="fixed inset-0 overflow-hidden pointer-events-none">
            {orbs.map((orb, i) => (
                <div
                    key={i}
                    className="absolute rounded-full blur-[100px]"
                    style={{
                        width: orb.size,
                        height: orb.size,
                        backgroundColor: orb.color,
                        top: orb.top,
                        left: orb.left,
                        right: orb.right,
                        opacity: orb.opacity ?? 0.35,
                    }}
                />
            ))}
        </div>
    );
}

/**
 * Token-driven ambient blooms (theme-adaptive: amber under `.cyberpunk`, etc.).
 * - `subtle` (default): two quiet corner orbs — the original; dashboard /
 *   DashboardLayout (clarity/shops/reas) safe, zero perf cost.
 * - `rich`: large amber/accent blooms + soft center bloom, STATIC.
 * - `rich-animated`: same, with `animate-pulse`. Opt-in ONLY for low-cost
 *   single-purpose pages (e.g. an auth screen). Do NOT use on content shells —
 *   pulsing viewport-scale blurred layers = continuous full-frame repaint →
 *   100% CPU / flicker across every consumer (AppShell + DashboardLayout).
 */
export function GlowOrbsNexus({ variant = "subtle" }: { variant?: "rich" | "rich-animated" | "subtle" }) {
    if (variant === "subtle") {
        return (
            <>
                <div className="absolute top-0 right-0 w-96 h-96 bg-primary/15 rounded-full blur-3xl -translate-y-1/3 translate-x-1/3 opacity-50" />
                <div className="absolute bottom-0 left-0 w-72 h-72 bg-accent/12 rounded-full blur-3xl translate-y-1/3 -translate-x-1/3 opacity-50" />
            </>
        );
    }

    const pulse = variant === "rich-animated" ? " animate-pulse" : "";

    // Soft ambient via layered radial-gradients (theme tokens → transparent).
    // NOT blurred circles: a blurred solid disc always has a visible core/edge
    // on sparse content; a gradient fades to nothing by construction (and costs
    // no filter — cheap even animated).
    // Explicit warm amber (the cyberpunk `--primary` value) — `rich` IS the
    // warm sign-in-style ambient by definition; using the literal avoids
    // var-resolution drift that muddied it cool over the purple-ish bg.
    // (`subtle` stays token-adaptive for theme-neutral consumers.)
    return (
        <div
            className={`absolute inset-0${pulse}`}
            style={{
                background:
                    "radial-gradient(75% 60% at 0% 0%, oklch(0.75 0.18 75 / 0.16), transparent 62%), radial-gradient(70% 60% at 100% 100%, oklch(0.65 0.15 195 / 0.22), transparent 60%)",
            }}
        />
    );
}
