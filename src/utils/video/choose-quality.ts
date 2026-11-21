/**
 * Picks one of the qualities a site offers. `quality` is `best` (also the default), `worst`, a height such as `720`
 * or `720p`, or one of an option's own names (`720p60`, `chunked`). `options` come best first; of two options with the
 * asked height, the first wins. A quality no option has throws, and the message lists what is offered.
 */
export function chooseQuality<T>({
    options,
    quality,
    names,
    height,
}: {
    options: T[];
    quality?: string;
    /** The option's names, the first one shown in the error. */
    names: (option: T) => string[];
    height: (option: T) => number | null | undefined;
}): T {
    if (options.length === 0) {
        throw new Error("No quality is offered");
    }

    const wanted = (quality ?? "best").trim().toLowerCase();

    if (wanted === "best") {
        return options[0];
    }

    if (wanted === "worst") {
        return options[options.length - 1];
    }

    const byName = options.find((option) => names(option).some((name) => name.toLowerCase() === wanted));

    if (byName) {
        return byName;
    }

    const asked = /^\d+p?$/.test(wanted) ? Number(wanted.replace(/p$/, "")) : null;
    const byHeight = asked === null ? undefined : options.find((option) => height(option) === asked);

    if (byHeight) {
        return byHeight;
    }

    const offered = options.map((option) => names(option)[0]).join(", ");
    throw new Error(`--quality ${quality} matches no variant. Offered: best, worst, ${offered}`);
}
