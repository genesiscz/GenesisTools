// Commander option coercers. They live here rather than in index.ts because that
// file ends in `runTool(program)` — importing it from a test would parse argv and
// run the CLI, so anything that needs coverage has to sit outside it.

import { parseDuration } from "@genesiscz/utils/format";
import { InvalidArgumentError } from "commander";

export function intOpt(name: string, opts: { min?: number; max?: number } = {}) {
    return (v: string): number => {
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || String(n) !== v.trim()) {
            throw new InvalidArgumentError(`${name} must be an integer (got "${v}").`);
        }

        if (opts.min !== undefined && n < opts.min) {
            throw new InvalidArgumentError(`${name} must be >= ${opts.min}.`);
        }

        if (opts.max !== undefined && n > opts.max) {
            throw new InvalidArgumentError(`${name} must be <= ${opts.max}.`);
        }

        return n;
    };
}

/**
 * `--changed-within 7d` → the epoch-SECOND cutoff the native core filters on.
 *
 * The unit change is the whole point: `parseDuration` returns milliseconds, and
 * the C side compares against `st_mtime`, which is seconds. Returning ms here
 * would put the cutoff ~50,000 years in the future and silently exclude every
 * file, so the `/ 1000` is load-bearing and pinned by options.test.ts.
 */
export function durationToCutoff(name: string) {
    return (v: string): number => {
        const ms = parseDuration(v);
        if (ms <= 0) {
            throw new InvalidArgumentError(`${name} must be a duration like 24h, 7d or 30m (got "${v}").`);
        }

        return Math.floor((Date.now() - ms) / 1000);
    };
}
