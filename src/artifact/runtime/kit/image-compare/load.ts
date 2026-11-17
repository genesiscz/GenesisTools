import { ALIGN_WINDOW, type CompareSize, estimateShift, type RgbaImage, type Shift } from "./core";

/**
 * The browser half of the pixels: an image URL to its natural size, to RGBA pixels (an <img> and a canvas), a cached
 * decoded pair with its shift estimate, and a small cache for what a pixel mode computes from that pair. No Web
 * Worker: `tools artifact build` makes one HTML file, and a worker URL is one more thing that can fail there, so the
 * work runs on the main thread after the browser goes idle.
 */

export const CORS_MESSAGE = "The diff needs images from this origin or with CORS headers.";

export interface PixelError {
    /** "cors": the browser refused to let the page read the pixels. "load": the image itself failed. */
    kind: "cors" | "load";
    message: string;
}

export type PixelLoad = { ok: true; image: RgbaImage } | { ok: false; error: PixelError };

/** Both decoded images of a comparison and the shift of B against A (null when none could be trusted). */
export interface PixelPair {
    a: RgbaImage;
    b: RgbaImage;
    shift: Shift | null;
}

export type PixelPairResult = { ok: true; pair: PixelPair } | { ok: false; error: PixelError };

/** Decoded images are a few MB each, so only the latest few stay. */
const MAX_PIXEL_ENTRIES = 12;
const pixelCache = new Map<string, Promise<PixelLoad>>();
const pairCache = new Map<string, Promise<PixelPairResult>>();
const sizeCache = new Map<string, Promise<CompareSize | null>>();

function remember<T>(cache: Map<string, T>, key: string, value: T, max: number): void {
    cache.delete(key);
    cache.set(key, value);

    for (const oldest of cache.keys()) {
        if (cache.size <= max) {
            break;
        }

        cache.delete(oldest);
    }
}

/** A response that has not finished by then counts as failed, so a hung server never leaves "Loading" forever. */
const IMAGE_LOAD_DEADLINE_MS = 30_000;

type ImageLoad = { ok: true; image: HTMLImageElement } | { ok: false; timedOut: boolean };

function loadImage(src: string, crossOrigin: boolean): Promise<ImageLoad> {
    return new Promise((resolve) => {
        const image = new Image();
        const settle = (result: ImageLoad): void => {
            window.clearTimeout(deadline);
            image.onload = null;
            image.onerror = null;
            resolve(result);
        };
        const deadline = window.setTimeout(() => {
            settle({ ok: false, timedOut: true });
            // An empty src stops the download; the handlers are gone, so its error event goes nowhere.
            image.src = "";
        }, IMAGE_LOAD_DEADLINE_MS);

        if (crossOrigin) {
            image.crossOrigin = "anonymous";
        }

        image.decoding = "async";
        image.onload = () => settle({ ok: true, image });
        image.onerror = () => settle({ ok: false, timedOut: false });
        image.src = src;
    });
}

/** True for an http(s) URL on another origin; data: and blob: URLs never need CORS. */
function isCrossOrigin(src: string): boolean {
    try {
        const url = new URL(src, window.location.href);

        return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== window.location.origin;
    } catch {
        // An unparsable src cannot be another origin; the load error names it instead.
        return false;
    }
}

/** The natural size of an image, or null when it does not load. Cached per URL. */
export function loadImageSize(src: string): Promise<CompareSize | null> {
    const cached = sizeCache.get(src);

    if (cached) {
        return cached;
    }

    const pending = loadImage(src, false).then((load) =>
        load.ok ? { width: load.image.naturalWidth, height: load.image.naturalHeight } : null
    );
    remember(sizeCache, src, pending, MAX_PIXEL_ENTRIES * 4);

    return pending;
}

/** The RGBA pixels of an image, or a typed error. A failed load is not cached, so a later try can succeed. */
export function loadImagePixels(src: string): Promise<PixelLoad> {
    const cached = pixelCache.get(src);

    if (cached) {
        return cached;
    }

    const pending = decodePixels(src);
    remember(pixelCache, src, pending, MAX_PIXEL_ENTRIES);
    void pending.then((result) => {
        if (!result.ok && pixelCache.get(src) === pending) {
            pixelCache.delete(src);
        }
    });

    return pending;
}

async function decodePixels(src: string): Promise<PixelLoad> {
    // crossOrigin makes the browser ask for CORS, so a server without the header fails the load instead of
    // tainting the canvas later.
    const load = await loadImage(src, true);

    if (!load.ok) {
        if (load.timedOut) {
            const seconds = IMAGE_LOAD_DEADLINE_MS / 1000;

            return {
                ok: false,
                error: { kind: "load", message: `The image did not load in ${seconds} s: ${src.slice(0, 120)}` },
            };
        }

        return isCrossOrigin(src)
            ? { ok: false, error: { kind: "cors", message: CORS_MESSAGE } }
            : { ok: false, error: { kind: "load", message: `The image did not load: ${src.slice(0, 120)}` } };
    }

    const { image } = load;
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (!context) {
        return { ok: false, error: { kind: "load", message: "This browser gave no 2D canvas to read the image." } };
    }

    context.drawImage(image, 0, 0);

    try {
        return { ok: true, image: { width, height, data: context.getImageData(0, 0, width, height).data } };
    } catch (error) {
        if (error instanceof DOMException && error.name === "SecurityError") {
            return { ok: false, error: { kind: "cors", message: CORS_MESSAGE } };
        }

        return { ok: false, error: { kind: "load", message: `The pixels could not be read: ${String(error)}` } };
    }
}

/** Resolves when the browser is idle, or after `timeout` ms at the latest. */
function whenIdle(timeout: number): Promise<void> {
    return new Promise((resolve) => {
        if (typeof window.requestIdleCallback === "function") {
            window.requestIdleCallback(() => resolve(), { timeout });
        } else {
            window.setTimeout(resolve, 1);
        }
    });
}

/**
 * Both images decoded and the shift of B against A estimated within `alignWindow` px either way, cached per pair and
 * window. A failed load is not cached.
 */
export function loadPixelPair({
    a,
    b,
    alignWindow = ALIGN_WINDOW,
}: {
    a: string;
    b: string;
    alignWindow?: number;
}): Promise<PixelPairResult> {
    const key = `${a}\n${b}\n${alignWindow}`;
    const cached = pairCache.get(key);

    if (cached) {
        return cached;
    }

    const pending = (async (): Promise<PixelPairResult> => {
        const [pixelsA, pixelsB] = await Promise.all([loadImagePixels(a), loadImagePixels(b)]);

        if (!pixelsA.ok) {
            return pixelsA;
        }

        if (!pixelsB.ok) {
            return pixelsB;
        }

        await whenIdle(500);

        return {
            ok: true,
            pair: {
                a: pixelsA.image,
                b: pixelsB.image,
                shift: estimateShift(pixelsA.image, pixelsB.image, alignWindow),
            },
        };
    })();
    remember(pairCache, key, pending, MAX_PIXEL_ENTRIES / 2);
    void pending.then((result) => {
        if (!result.ok && pairCache.get(key) === pending) {
            pairCache.delete(key);
        }
    });

    return pending;
}

export interface Computed<T> {
    value: T;
    /** Main-thread time of the computation. */
    ms: number;
}

/** What a pixel mode computes from a pair (a diff, a heat map), cached by a key the mode builds from its inputs. */
export interface IdleCache<T> {
    peek: (key: string) => Computed<T> | undefined;
    /**
     * Computes after the browser goes idle, once per key; callers asking for a running key share it. Each caller's
     * signal speaks for that caller only: the work runs while any caller still waits, and resolves null for a caller
     * whose signal aborted. When every caller left before the work starts, it is skipped and leaves no entry, so a
     * dragged slider computes only the value it stops on.
     */
    run: (options: { key: string; compute: () => T; signal: AbortSignal }) => Promise<Computed<T> | null>;
}

/** A computation waiting for the browser to go idle, and every caller waiting for it. */
interface IdleJob<T> {
    pending: Promise<Computed<T> | null>;
    /** The work runs the compute of the first caller still waiting; one key always means the same inputs. */
    callers: { compute: () => T; signal: AbortSignal }[];
}

export function createIdleCache<T>(max: number): IdleCache<T> {
    const done = new Map<string, Computed<T>>();
    const running = new Map<string, IdleJob<T>>();

    const start = (key: string): IdleJob<T> => {
        const callers: IdleJob<T>["callers"] = [];
        const pending = whenIdle(500).then(() => {
            running.delete(key);
            const live = callers.find((caller) => !caller.signal.aborted);

            if (!live) {
                return null;
            }

            const started = performance.now();
            const result = { value: live.compute(), ms: performance.now() - started };
            remember(done, key, result, max);

            return result;
        });
        const job = { pending, callers };
        running.set(key, job);

        return job;
    };

    return {
        peek: (key) => done.get(key),
        run: ({ key, compute, signal }) => {
            const hit = done.get(key);

            if (hit) {
                return Promise.resolve(hit);
            }

            const job = running.get(key) ?? start(key);
            job.callers.push({ compute, signal });

            return job.pending.then((result) => (signal.aborted ? null : result));
        },
    };
}
