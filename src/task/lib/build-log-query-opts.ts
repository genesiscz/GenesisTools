import { resolveStreamFilter } from "@app/task/lib/stream-filter";
import { tailOrQuery } from "@app/task/lib/tail-session";
import type { LogCliOpts, LogOutputFormat, LogQueryOpts } from "@app/task/types";

export function buildLogQueryOpts(session: string, opts: LogCliOpts): LogQueryOpts {
    const format: LogOutputFormat = opts.jsonl ? "jsonl" : opts.raw ? "raw" : "human";

    return {
        session,
        head: opts.head ? Number.parseInt(opts.head, 10) : undefined,
        tail: opts.tail ? Number.parseInt(opts.tail, 10) : undefined,
        all: Boolean(opts.all),
        fromSeq: opts.fromSeq ? Number.parseInt(opts.fromSeq, 10) : undefined,
        toSeq: opts.toSeq ? Number.parseInt(opts.toSeq, 10) : undefined,
        grep: opts.grep,
        format,
        streams: resolveStreamFilter({ stdout: opts.stdout, stderr: opts.stderr }),
    };
}

export { tailOrQuery };
