import type { ResolveRequest } from "./resolvers/types.ts";

/**
 * Parses `<url>:<offset>` (a LoAF `sourceCharPosition`) or `<url>:<line>:<column>` (a stack frame,
 * 1-based line, 0-based column). The URL keeps its own `https:` colon.
 */
export function parsePositionRef(ref: string): ResolveRequest {
    const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(ref.trim());
    if (!match || !/^[a-z]+:\/\//i.test(match[1])) {
        throw new Error(`expected <url>:<offset> or <url>:<line>:<column>, got '${ref}'`);
    }

    const [, url, first, second] = match;
    return second === undefined
        ? { url, position: { offset: Number(first) } }
        : { url, position: { line: Number(first), column: Number(second) } };
}

/** `KEY=VALUE` pairs into an environment object. */
export function parseEnvPairs(pairs: string[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (const pair of pairs) {
        const at = pair.indexOf("=");
        if (at <= 0) {
            throw new Error(`--env expects KEY=VALUE, got '${pair}'`);
        }

        env[pair.slice(0, at)] = pair.slice(at + 1);
    }

    return env;
}
