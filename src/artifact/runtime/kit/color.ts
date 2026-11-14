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

/**
 * Parse `#rgb`, `#rrggbb`, `rgb()`/`rgba()`, and the colour spaces a browser keeps in a COMPUTED value
 * (`color-mix(in oklch, …)` computes to `oklch(…)`): `oklch()`, `oklab()`, `lab()`, `lch()` and
 * `color(srgb | srgb-linear | display-p3 …)`. Wide-gamut colours are clipped into sRGB. Anything else is null.
 */
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

    const fn = text.match(/^(oklch|oklab|lab|lch|color)\(([^)]*)\)$/);

    if (!fn) {
        return null;
    }

    const body = fn[2].split("/")[0].trim().split(/\s+/);
    const space = fn[1] === "color" ? body.shift() : fn[1];
    const convert = space ? TO_LINEAR_SRGB[space] : undefined;

    if (!convert || body.length !== 3) {
        return null;
    }

    const linear = convert(body);

    if (linear.some((c) => !Number.isFinite(c))) {
        return null;
    }

    const [r, g, b] = map3(linear, (c) => encodeSrgb(Math.min(1, Math.max(0, c))) * 255);

    return { r, g, b };
}

type Vec3 = [number, number, number];
type Matrix3 = [Vec3, Vec3, Vec3];

/** One CSS number token; `percent` is the value of 100% (Color 4 reference ranges), `none` is 0. */
function component(token: string, percent: number): number {
    if (token === "none") {
        return 0;
    }

    return token.endsWith("%") ? (Number.parseFloat(token) / 100) * percent : Number(token);
}

/** Degrees per hue unit. A bare number is degrees. */
const HUE_UNITS: Record<string, number> = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };

/**
 * A hue token in degrees (`deg`, `rad`, `grad`, `turn` or a bare number). The unit is every letter after the
 * number, so `100grad` reads as grad and never as its `rad` suffix.
 */
function hue(token: string): number {
    if (token === "none") {
        return 0;
    }

    const n = Number.parseFloat(token);
    const unit = /[a-z]+$/.exec(token)?.[0];

    return unit && unit in HUE_UNITS ? n * HUE_UNITS[unit] : n;
}

function map3<T>(values: readonly T[], f: (value: T) => number): Vec3 {
    return [f(values[0]), f(values[1]), f(values[2])];
}

function multiply(m: Matrix3, [x, y, z]: Vec3): Vec3 {
    return [
        m[0][0] * x + m[0][1] * y + m[0][2] * z,
        m[1][0] * x + m[1][1] * y + m[1][2] * z,
        m[2][0] * x + m[2][1] * y + m[2][2] * z,
    ];
}

function decodeSrgb(c: number): number {
    const abs = Math.abs(c);

    return abs <= 0.04045 ? c / 12.92 : Math.sign(c) * ((abs + 0.055) / 1.055) ** 2.4;
}

function encodeSrgb(c: number): number {
    return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** CSS Color 4 sample code matrices. */
const XYZ_D65_TO_LINEAR_SRGB: Matrix3 = [
    [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
    [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
    [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const XYZ_D50_TO_D65: Matrix3 = [
    [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
    [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
    [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
];
const LINEAR_P3_TO_XYZ_D65: Matrix3 = [
    [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
    [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
    [0, 0.04511338185890264, 1.043944368900976],
];

function oklabToLinearSrgb(l: number, a: number, b: number): Vec3 {
    const lms = map3(
        [
            l + 0.3963377774 * a + 0.2158037573 * b,
            l - 0.1055613458 * a - 0.0638541728 * b,
            l - 0.0894841775 * a - 1.291485548 * b,
        ],
        (c) => c ** 3
    );

    return [
        4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
        -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
        -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
    ];
}

function labToLinearSrgb(l: number, a: number, b: number): Vec3 {
    const kappa = 24389 / 27;
    const epsilon = 216 / 24389;
    const fy = (l + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - b / 200;
    const xyzD50: Vec3 = [
        (fx ** 3 > epsilon ? fx ** 3 : (116 * fx - 16) / kappa) * (0.3457 / 0.3585),
        l > kappa * epsilon ? fy ** 3 : l / kappa,
        (fz ** 3 > epsilon ? fz ** 3 : (116 * fz - 16) / kappa) * ((1 - 0.3457 - 0.3585) / 0.3585),
    ];

    return multiply(XYZ_D65_TO_LINEAR_SRGB, multiply(XYZ_D50_TO_D65, xyzD50));
}

/** Polar (lightness, chroma, hue in degrees) to the rectangular a and b. */
function polar(l: number, c: number, h: number): Vec3 {
    const rad = (h * Math.PI) / 180;

    return [l, c * Math.cos(rad), c * Math.sin(rad)];
}

const TO_LINEAR_SRGB: Record<string, (t: string[]) => Vec3> = {
    oklab: (t) => oklabToLinearSrgb(component(t[0], 1), component(t[1], 0.4), component(t[2], 0.4)),
    oklch: (t) => oklabToLinearSrgb(...polar(component(t[0], 1), component(t[1], 0.4), hue(t[2]))),
    lab: (t) => labToLinearSrgb(component(t[0], 100), component(t[1], 125), component(t[2], 125)),
    lch: (t) => labToLinearSrgb(...polar(component(t[0], 100), component(t[1], 150), hue(t[2]))),
    srgb: (t) => map3(t, (c) => decodeSrgb(component(c, 1))),
    "srgb-linear": (t) => map3(t, (c) => component(c, 1)),
    "display-p3": (t) =>
        multiply(
            XYZ_D65_TO_LINEAR_SRGB,
            multiply(
                LINEAR_P3_TO_XYZ_D65,
                map3(t, (c) => decodeSrgb(component(c, 1)))
            )
        ),
};

/** WCAG 2 relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance({ r, g, b }: Rgb): number {
    const channel = (value: number): number => decodeSrgb(value / 255);

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

/** White or near-black, with black at the narrow midtone range where neither reaches AA. */
export function readableTextOn(fill: string): string {
    const darkRatio = contrastRatio(fill, TEXT_ON_LIGHT);
    const lightRatio = contrastRatio(fill, TEXT_ON_DARK);
    if (darkRatio < 4.5 && lightRatio < 4.5 && parseCssColor(fill)) {
        return "#000000";
    }

    return darkRatio > lightRatio ? TEXT_ON_LIGHT : TEXT_ON_DARK;
}

/**
 * `readableTextOn` for an inline style over a COMPUTED fill: "" (keep the stylesheet's ink) when the fill is a
 * colour this module cannot read, instead of the white that an unreadable fill would get from the contrast maths.
 */
export function readableInlineInk(fill: string): string {
    return parseCssColor(fill) ? readableTextOn(fill) : "";
}
