import { resolveStreamFilter } from "@app/task/lib/stream-filter";
import { tailOrQuery } from "@app/task/lib/tail-session";
import type { LogOutputFormat, LogQueryOpts } from "@app/task/types";

export function buildLogQueryOpts(
    session: string,
    opts: {
        lines?: string;
        fromSeq?: string;
        toSeq?: string;
        grep?: string;
        jsonl?: boolean;
        raw?: boolean;
        stdout?: boolean;
        stderr?: boolean;
        tail?: boolean;
        follow?: boolean;
        all?: boolean;
    }
): LogQueryOpts {
    const format: LogOutputFormat = opts.jsonl ? "jsonl" : opts.raw ? "raw" : "human";

    return {
        session,
        lines: opts.all ? undefined : opts.lines ? Number.parseInt(opts.lines, 10) : 50,
        fromSeq: opts.fromSeq ? Number.parseInt(opts.fromSeq, 10) : undefined,
        toSeq: opts.toSeq ? Number.parseInt(opts.toSeq, 10) : undefined,
        grep: opts.grep,
        format,
        streams: resolveStreamFilter({ stdout: opts.stdout, stderr: opts.stderr }),
    };
}

export { tailOrQuery };
