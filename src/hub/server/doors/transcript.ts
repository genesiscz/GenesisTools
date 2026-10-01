import { asResult } from "@genesiscz/utils/cli/result";
import { parseArgv, stringFlag, wholeNumber } from "../argv";
import { type CallDoor, failed, ok, type StreamDoor } from "./types";

/** `tools ai sessions tail` defaults (src/utils/ai/transcripts/types.ts DEFAULT_TURN_LIMIT is 80). */
const TAIL_FLAGS = { "--json": "bool", "--limit": "value", "--offset": "value", "--live": "bool" } as const;

interface FetchArgs {
    query: string;
    limit: number;
    offset?: number;
}

/** `ai sessions tail <q> --json [--limit N] [--offset N]`: the Session Details envelope. */
export const transcriptFetchDoor: CallDoor<FetchArgs> = {
    kind: "call",
    name: "ai sessions tail --json",
    match(argv) {
        const parsed = parseArgv(argv, { command: ["ai", "sessions", "tail"], positionals: 1, flags: TAIL_FLAGS });
        if (parsed?.flags.get("--json") !== true || parsed.flags.has("--live")) {
            return null;
        }

        const limit = parsed.flags.has("--limit") ? wholeNumber(parsed.flags.get("--limit")) : 80;
        const offset = parsed.flags.has("--offset") ? wholeNumber(parsed.flags.get("--offset")) : undefined;
        if (limit === null || limit < 1 || offset === null) {
            return null;
        }

        return { query: parsed.positionals[0], limit, offset };
    },
    async run(args, { signal }) {
        try {
            const { resolveTranscript } = await import("@genesiscz/utils/ai/transcripts/resolve");
            const { transcriptEnvelope } = await import("@genesiscz/utils/ai/transcripts/load");
            // A cancel stops the work at each stage: before resolving, and before reading the page.
            signal.throwIfAborted();
            const resolved = await resolveTranscript(args.query, {});
            signal.throwIfAborted();
            return ok(asResult(await transcriptEnvelope(resolved, { offset: args.offset, limit: args.limit })));
        } catch (error) {
            return failed(error);
        }
    },
};

interface LiveArgs {
    query: string;
    offset: number;
}

/** `ai sessions tail <q> --live --offset N`: the hub's follow of an open transcript. */
export const transcriptLiveDoor: StreamDoor<LiveArgs> = {
    kind: "stream",
    name: "ai sessions tail --live",
    match(argv) {
        const parsed = parseArgv(argv, { command: ["ai", "sessions", "tail"], positionals: 1, flags: TAIL_FLAGS });
        if (parsed?.flags.get("--live") !== true || parsed.flags.has("--json")) {
            return null;
        }

        const offset = wholeNumber(stringFlag(parsed, "--offset"));
        return offset === null ? null : { query: parsed.positionals[0], offset };
    },
    async stream(args, ctx) {
        const { resolveTranscript } = await import("@genesiscz/utils/ai/transcripts/resolve");
        const { followTranscriptLive } = await import("@genesiscz/utils/ai/transcripts/live");
        try {
            const resolved = await resolveTranscript(args.query, {});
            await followTranscriptLive(resolved, { offset: args.offset, signal: ctx.signal, write: ctx.write });
            return ok("");
        } catch (error) {
            return failed(error);
        }
    },
};
