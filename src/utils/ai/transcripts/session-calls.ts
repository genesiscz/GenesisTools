/**
 * Every model call a session paid for: its own transcript's calls and the calls of each of its agents' transcripts.
 * Provider-neutral: the calls come from the session reader's `analysis.callTrace` and the agent transcripts from the
 * sub-agent listing, so this file names no transcript format and no folder.
 *
 * Claude Code writes each agent's calls into the agent's own file. A report that read only the lead's transcript
 * printed "sub-agents $0" for session 1d7131fa, whose 183 agent transcripts held $1,485 of its $1,745 (2026-11-10).
 */
import { factsOf, type SessionCall, type SessionFacts } from "@genesiscz/utils/agent-sessions/analysis-types";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import { concurrentMap } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import type { ResolvedTranscript } from "./resolve";
import { listSubagents } from "./subagents";

const PARALLEL_TRANSCRIPTS = 8;

export interface SessionCalls {
    /**
     * The lead's calls and its agents' calls, oldest first, each call once by its id across every file. An agent's
     * call is a `sidechain` call, as it is when an older harness wrote it into the lead's own transcript.
     */
    calls: SessionFacts<SessionCall>;
    /** How many agent transcripts were read. */
    agentTranscripts: number;
    /** Agent transcripts that could not be read: their calls are missing from `calls`. */
    unreadable: string[];
}

export async function sessionCallsWithAgents(resolved: ResolvedTranscript): Promise<SessionCalls> {
    const analysis = resolveHistoryProvider(resolved.provider).reader.analysis;
    const lead = await analysis.callTrace(resolved.filePath);

    if (!lead.supported) {
        return { calls: lead, agentTranscripts: 0, unreadable: [] };
    }

    const files = listSubagents(resolved).subagents.flatMap((agent) => agent.files);
    const unreadable: string[] = [];
    const traces = await concurrentMap({
        items: files,
        fn: (file) => analysis.callTrace(file),
        concurrency: PARALLEL_TRANSCRIPTS,
        onError: (file, error) => {
            unreadable.push(file);
            logger.warn({ error, file }, "[transcripts] agent transcript unreadable, its calls are not counted");
        },
    });
    const seen = new Set(lead.items.map((call) => call.id));
    const calls = [...lead.items];

    for (const file of files) {
        const trace = traces.get(file);

        for (const call of trace ? factsOf(trace) : []) {
            if (!seen.has(call.id)) {
                seen.add(call.id);
                calls.push({ ...call, sidechain: true });
            }
        }
    }

    calls.sort((a, b) => a.t.localeCompare(b.t));
    return { calls: { supported: true, items: calls }, agentTranscripts: files.length, unreadable };
}
