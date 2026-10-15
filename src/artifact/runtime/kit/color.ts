/**
 * WCAG colour maths for the kit: parse a resolved CSS colour, compute the
 * relative luminance and the contrast ratio, and pick readable text for a
 * fill. Pure, so the theme tests and the Gantt bar labels share one copy.
 */

export interface Rgb {
    r: number;
    g: number;
    b: number;
}

/** Parse `#rgb`, `#rrggbb`, `rgb(r, g, b)` or `rgb(r g b / a)`. Anything else is null. */
export function parseCssColor(value: string): Rgb | null {
    const text = value.trim().toLowerCase();
    const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);

    if (hex) {
        const digits =
            hex[1].length === 3
                ? hex[1]
                      .split("")
                      .map((d) => d + d)
                      .join("")
                : hex[1];

        return {
            r: Number.parseInt(digits.slice(0, 2), 16),
            g: Number.parseInt(digits.slice(2, 4), 16),
            b: Number.parseInt(digits.slice(4, 6), 16),
        };
    }

    const rgb = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);

    if (rgb) {
        return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
    }

    return null;
}

/** WCAG 2 relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance({ r, g, b }: Rgb): number {
    const channel = (value: number): number => {
        const c = value / 255;

        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };

    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio of two colours, 1 to 21. Unparseable input gives 1. */
export function contrastRatio(a: string, b: string): number {
    const ca = parseCssColor(a);
    const cb = parseCssColor(b);

    if (!ca || !cb) {
        return 1;
    }

    const la = relativeLuminance(ca);
    const lb = relativeLuminance(cb);

    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const TEXT_ON_DARK = "#ffffff";
export const TEXT_ON_LIGHT = "#111318";

/** White or near-black, whichever reads better on `fill`. Unparseable fills get white. */
export function readableTextOn(fill: string): string {
    return contrastRatio(fill, TEXT_ON_LIGHT) > contrastRatio(fill, TEXT_ON_DARK) ? TEXT_ON_LIGHT : TEXT_ON_DARK;
}
