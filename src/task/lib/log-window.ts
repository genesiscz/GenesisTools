import type { LogCliOpts } from "@app/task/types";

export function applyLogWindowDefaults(opts: LogCliOpts, defaults: { ttyTail: string }): LogCliOpts {
    const noExplicit = !opts.head && !opts.tail && !opts.all && !opts.fromSeq && !opts.toSeq;

    if (noExplicit) {
        if (process.stdout.isTTY) {
            return { ...opts, tail: defaults.ttyTail };
        }

        return { ...opts, all: true };
    }

    return opts;
}

export function applyGrepImpliesAll(opts: LogCliOpts): LogCliOpts {
    if (opts.grep && !opts.head && !opts.tail && !opts.all) {
        return { ...opts, all: true };
    }

    return opts;
}
