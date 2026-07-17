import { type CSSProperties, type ReactNode, useId } from "react";

/** Diamond counts are shown with a thin-space thousands separator ("1 500")
 *  everywhere the credit balance appears — this collapses the repeated
 *  `.toLocaleString("en-US").replace(",", " ")` dance into one call. */
export function formatDiamonds(amount: number): string {
    return Math.round(amount).toLocaleString("en-US").replace(/,/g, " ");
}

/**
 * The single diamond glyph for the whole product (spec §7: "diamonds GLOW;
 * colors more playful, gradients"). An inline SVG gem with a theme-driven
 * gradient (primary → secondary accent) and an optional soft glow — replaces
 * the bare `💎` emoji and lucide `Gem` so every surface reads as one currency.
 *
 * Browser-safe: no `@app/logger` value import, pure presentational. Gradient
 * stops reference the shadow-root CSS vars (`--primary` / `--secondary`) so it
 * tracks the active theme instead of hardcoding a palette.
 */
export function Diamond({
    size = 16,
    glow = false,
    className,
    title,
}: {
    size?: number;
    /** Adds the animated aura — reserve for hero/balance spots, not dense rows. */
    glow?: boolean;
    className?: string;
    /** When set, the glyph is announced to screen readers; otherwise decorative. */
    title?: string;
}) {
    // Each instance needs its own gradient id — two <Diamond>s sharing one id
    // in the same document would let the first define the paint for both.
    const gradientId = `yt-diamond-${useId()}`;
    const glowStyle: CSSProperties | undefined = glow
        ? { filter: `drop-shadow(0 0 ${size * 0.28}px hsl(var(--primary) / 0.65))` }
        : undefined;

    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
            style={glowStyle}
            role={title ? "img" : "presentation"}
            aria-hidden={title ? undefined : true}
            aria-label={title}
        >
            {title ? <title>{title}</title> : null}
            <defs>
                <linearGradient id={gradientId} x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
                    <stop stopColor="hsl(var(--primary))" />
                    <stop offset="0.55" stopColor="hsl(var(--secondary, var(--primary)))" />
                    <stop offset="1" stopColor="hsl(var(--primary))" />
                </linearGradient>
            </defs>
            {/* Gem silhouette: crown (top band) + pavilion (point). */}
            <path
                d="M6 3.5h12l3.2 5.1L12 21.2 2.8 8.6 6 3.5Z"
                fill={`url(#${gradientId})`}
                stroke="hsl(var(--primary-foreground) / 0.35)"
                strokeWidth="0.6"
                strokeLinejoin="round"
            />
            {/* Facet lines — the sparkle read, kept subtle. */}
            <path
                d="M2.8 8.6h18.4M9 3.5 12 8.6l3-5.1M6.4 8.6 12 21.2l5.6-12.6"
                stroke="hsl(var(--primary-foreground) / 0.4)"
                strokeWidth="0.6"
                strokeLinejoin="round"
                strokeLinecap="round"
                fill="none"
            />
        </svg>
    );
}

/** Balance/price cluster: the glyph + a tabular-nums count, spaced and aligned
 *  the way every credit readout in the product wants it. */
export function DiamondValue({
    amount,
    size = 16,
    glow = false,
    className,
    children,
}: {
    amount: number;
    size?: number;
    glow?: boolean;
    className?: string;
    /** Trailing label ("diamonds", "/mo") rendered muted after the count. */
    children?: ReactNode;
}) {
    return (
        <span className={`inline-flex items-baseline gap-1.5 ${className ?? ""}`}>
            <Diamond size={size} glow={glow} className="self-center" />
            <span className="font-semibold tabular-nums">{formatDiamonds(amount)}</span>
            {children ? <span className="text-xs text-muted-foreground">{children}</span> : null}
        </span>
    );
}
