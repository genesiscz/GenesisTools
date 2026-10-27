import { asResult } from "@genesiscz/utils/cli/result";
import { resolveMaxCacheAge } from "@genesiscz/utils/storage/cache-flag";
import { currentTraceId } from "@genesiscz/utils/trace";
import { parseArgv, stringFlag, wholeNumber } from "../argv";
import { type SessionRowsJob, SessionRowsRunner } from "../session-rows";
import { type CallDoor, failed, ok } from "./types";

/** `hub forecast --json`: when each AI account's windows run out (recorded snapshots only, never fetches). */
export const forecastDoor: CallDoor<true> = {
    kind: "call",
    name: "hub forecast --json",
    command: ["hub", "forecast"],
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
    command: ["hub", "procs"],
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
    command: ["hub", "stuck", "check"],
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
    command: ["question", "inbox"],
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
    command: ["hub", "repo"],
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

const sessionRows = new SessionRowsRunner();

/**
 * `ai usage sessions --json [--hours N] [--min N] [--limit N] [--fresh]`: the session list the hub and
 * Genesis.app poll. A `--provider` list stays a process (its enum errors print from the CLI). The rebuild runs on a
 * worker thread (`SessionRowsRunner`), so the other doors keep answering while it walks the transcripts.
 */
export const usageSessionsDoor: CallDoor<SessionRowsJob> = {
    kind: "call",
    name: "ai usage sessions --json",
    command: ["ai", "usage", "sessions"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["ai", "usage", "sessions"],
            positionals: 0,
            flags: {
                "--json": "bool",
                "--fresh": "bool",
                "--no-cache-write": "bool",
                "--journal-only": "bool",
                "--hours": "value",
                "--min": "value",
                "--limit": "value",
            },
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

        return {
            listing,
            fresh: parsed.flags.get("--fresh") === true,
            cacheWrite: parsed.flags.get("--no-cache-write") !== true,
            liveLocations: parsed.flags.get("--journal-only") !== true,
        };
    },
    async run(job, { signal }) {
        try {
            signal.throwIfAborted();
            return ok(await sessionRows.run(job, currentTraceId()));
        } catch (error) {
            return failed(error);
        }
    },
};

interface ProposalListArgs {
    pr?: { provider: "github" | "gitlab"; host: string; project: string; number: number };
}

/**
 * `hub proposal list --json [--provider P --host H --project X --number N]`: the review window asks it for its PR on
 * every open (one file read, behind a 0.35 s process start before this door). The four PR flags go together; any
 * other shape stays a process, which prints the CLI's error.
 */
export const proposalListDoor: CallDoor<ProposalListArgs> = {
    kind: "call",
    name: "hub proposal list --json",
    command: ["hub", "proposal", "list"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["hub", "proposal", "list"],
            positionals: 0,
            flags: {
                "--json": "bool",
                "--provider": "value",
                "--host": "value",
                "--project": "value",
                "--number": "value",
            },
        });
        if (parsed?.flags.get("--json") !== true) {
            return null;
        }

        const provider = stringFlag(parsed, "--provider");
        const host = stringFlag(parsed, "--host");
        const project = stringFlag(parsed, "--project");
        const number = parsed.flags.has("--number") ? wholeNumber(parsed.flags.get("--number")) : undefined;
        if ([provider, host, project, number].every((value) => value === undefined)) {
            return {};
        }

        if ((provider !== "github" && provider !== "gitlab") || !host || !project || !number) {
            return null;
        }

        return { pr: { provider, host, project, number } };
    },
    async run({ pr }, { signal }) {
        try {
            signal.throwIfAborted();
            const { listProposals, listProposalsFor, proposalListRows } = await import("../../lib/proposal");
            return ok(asResult(proposalListRows(pr ? listProposalsFor(pr) : listProposals())));
        } catch (error) {
            return failed(error);
        }
    },
};
