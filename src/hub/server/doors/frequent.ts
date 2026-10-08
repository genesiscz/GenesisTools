import { asResult } from "@genesiscz/utils/cli/result";
import { resolveMaxCacheAge } from "@genesiscz/utils/storage/cache-flag";
import { parseArgv, stringFlag, wholeNumber } from "../argv";
import { type CallDoor, failed, ok } from "./types";

/** `hub forecast --json`: when each AI account's windows run out (recorded snapshots only, never fetches). */
export const forecastDoor: CallDoor<true> = {
    kind: "call",
    name: "hub forecast --json",
    match(argv) {
        const parsed = parseArgv(argv, { command: ["hub", "forecast"], positionals: 0, flags: { "--json": "bool" } });
        return parsed?.flags.get("--json") === true ? true : null;
    },
    async run(_parsed, { signal }) {
        try {
            // A cancel that arrived before the work started stops it here.
            signal.throwIfAborted();
            const { buildForecast } = await import("../../lib/forecast");
            return ok(asResult(await buildForecast({})));
        } catch (error) {
            return failed(error);
        }
    },
};

/**
 * `hub procs --json`: the agent process monitor's list. Only the list: `--stop`, `--stop-orphans` and every
 * other flag stay a process (a stop is a write, and a terminal confirmation).
 */
export const procsDoor: CallDoor<true> = {
    kind: "call",
    name: "hub procs --json",
    match(argv) {
        const parsed = parseArgv(argv, { command: ["hub", "procs"], positionals: 0, flags: { "--json": "bool" } });
        return parsed?.flags.get("--json") === true ? true : null;
    },
    async run(_parsed, { signal }) {
        try {
            // A cancel that arrived before the work started stops it here.
            signal.throwIfAborted();
            const { readProcsReport } = await import("../../lib/procs/sources");
            return ok(asResult(await readProcsReport({ energy: false })));
        } catch (error) {
            return failed(error);
        }
    },
};

/** `hub stuck check --json --session <id…>`: the verdicts the session badge shows, with the saved thresholds. */
export const stuckDoor: CallDoor<string[]> = {
    kind: "call",
    name: "hub stuck check --json",
    match(argv) {
        // `--session` is variadic in the CLI, so the hub puts it last; this door takes exactly that shape.
        const head = ["hub", "stuck", "check", "--json", "--session"];
        if (argv.length <= head.length || head.some((word, index) => argv[index] !== word)) {
            return null;
        }

        const ids = argv.slice(head.length);
        return ids.every((id) => !id.startsWith("-")) ? ids : null;
    },
    async run(sessionIds, { signal }) {
        try {
            // A cancel that arrived before the work started stops it here.
            signal.throwIfAborted();
            const { readStuckThresholds } = await import("../../lib/insights/stuck");
            const { stuckSessions } = await import("../../lib/insights/index");
            const thresholds = readStuckThresholds();
            const sessions = await stuckSessions({ sessionIds, thresholds });
            return ok(asResult({ thresholds, checked: sessions.length, sessions }));
        } catch (error) {
            return failed(error);
        }
    },
};

type InboxArgs = { session: string } | { hours: number };

/** `question inbox --json [--hours N]` (the Inbox mode) and `question inbox --session <id> --json` (Decisions). */
export const inboxDoor: CallDoor<InboxArgs> = {
    kind: "call",
    name: "question inbox --json",
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["question", "inbox"],
            positionals: 0,
            flags: { "--json": "bool", "--session": "value", "--hours": "value" },
        });
        if (parsed?.flags.get("--json") !== true) {
            return null;
        }

        const session = stringFlag(parsed, "--session");
        if (session) {
            return parsed.flags.has("--hours") ? null : { session };
        }

        const hours = parsed.flags.has("--hours") ? wholeNumber(parsed.flags.get("--hours")) : 72;
        return hours === null || hours < 1 ? null : { hours };
    },
    async run(args, { signal }) {
        try {
            // A cancel that arrived before the work started stops it here.
            signal.throwIfAborted();
            const inbox = await import("@app/question/lib/inbox/load");
            if ("session" in args) {
                const decisions = await inbox.loadSessionDecisions(args.session);
                return ok(asResult({ sessionId: args.session, decisions }));
            }

            return ok(asResult(await inbox.loadInbox({ hours: args.hours })));
        } catch (error) {
            return failed(error);
        }
    },
};

interface RepoArgs {
    paths: string[];
    withPr: boolean;
    maxCacheAgeSeconds: number;
}

/**
 * `hub repo <paths…> [--pr] [--max-cache-age N] [--fresh]`: checkout, branch, web pages and PR of each folder.
 * The hub asks it for every worktree row (115 process runs on 2026-10-08, ~240 ms of Bun startup each). Only
 * absolute paths: a relative one would resolve against the server's directory, not the caller's.
 */
export const repoDoor: CallDoor<RepoArgs> = {
    kind: "call",
    name: "hub repo",
    match(argv) {
        if (argv[0] !== "hub" || argv[1] !== "repo") {
            return null;
        }

        const paths: string[] = [];
        let withPr = false;
        let fresh = false;
        let maxCacheAge: number | undefined;
        const rest = argv.slice(2);
        for (let index = 0; index < rest.length; index++) {
            const token = rest[index];
            if (!token.startsWith("-")) {
                if (!token.startsWith("/")) {
                    return null;
                }

                paths.push(token);
                continue;
            }

            if (token === "--pr" && !withPr) {
                withPr = true;
                continue;
            }

            if (token === "--fresh" && !fresh) {
                fresh = true;
                continue;
            }

            if (token === "--max-cache-age" && maxCacheAge === undefined) {
                const value = wholeNumber(rest[index + 1]);
                if (value === null) {
                    return null;
                }

                maxCacheAge = value;
                index++;
                continue;
            }

            return null;
        }

        return paths.length > 0
            ? { paths, withPr, maxCacheAgeSeconds: resolveMaxCacheAge({ maxCacheAge, fresh }) }
            : null;
    },
    async run(args, { signal }) {
        try {
            signal.throwIfAborted();
            const { repoFactsMany } = await import("@genesiscz/utils/git/repo-facts");
            return ok(asResult(await repoFactsMany(args)));
        } catch (error) {
            return failed(error);
        }
    },
};

/**
 * `ai usage sessions --json [--hours N] [--min N] [--limit N] [--fresh]`: the session list the hub and
 * Genesis.app poll. A `--provider` list stays a process (its enum errors print from the CLI).
 */
export const usageSessionsDoor: CallDoor<{ listing: Record<string, number>; fresh: boolean }> = {
    kind: "call",
    name: "ai usage sessions --json",
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["ai", "usage", "sessions"],
            positionals: 0,
            flags: { "--json": "bool", "--fresh": "bool", "--hours": "value", "--min": "value", "--limit": "value" },
        });
        if (parsed?.flags.get("--json") !== true) {
            return null;
        }

        const listing: Record<string, number> = {};
        for (const [flag, key] of [
            ["--hours", "hours"],
            ["--min", "minRows"],
            ["--limit", "limit"],
        ] as const) {
            if (!parsed.flags.has(flag)) {
                continue;
            }

            const value = wholeNumber(parsed.flags.get(flag));
            if (value === null || value < 1) {
                return null;
            }

            listing[key] = value;
        }

        return { listing, fresh: parsed.flags.get("--fresh") === true };
    },
    async run({ listing, fresh }, { signal }) {
        try {
            signal.throwIfAborted();
            const { sessionRowsJson } = await import("@app/ai/lib/sessions/rows-cache");
            const { listAgentSessionRows } = await import("@app/ai/lib/sessions/agent-session-rows");
            return ok(asResult(await sessionRowsJson(listing, { fresh, listRows: listAgentSessionRows })));
        } catch (error) {
            return failed(error);
        }
    },
};
