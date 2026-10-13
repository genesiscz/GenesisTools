import { asResult } from "@genesiscz/utils/cli/result";
import { writeStdout } from "@genesiscz/utils/cli/stdout";
import { SafeJSON } from "@genesiscz/utils/json";
import { FriendlyError } from "./errors";
import type { AgentMode, AgentRecord } from "./types";

export interface LoginReadyEvent {
    type: "ready";
    agent_id: string;
    agent_name: string;
    session: string;
    mode: AgentMode;
    is_main: boolean;
}

/** A `--once --timeout` that expired with an empty mailbox. */
export interface LoginTimeoutEvent {
    type: "timeout";
    agent_name: string;
    session: string;
    waited_ms: number;
}

/** `monitor`: a headline line, then the `json` line. `json`: one JSON object per line. `pretty`: colored text. */
export const FEED_FORMATS = ["monitor", "json", "pretty"] as const;

export type FeedFormat = (typeof FEED_FORMATS)[number];

/**
 * An explicit --format wins. Otherwise a pipe (a Monitor, a script) gets `monitor`, whose second line per event is
 * the `json` line, and a terminal gets the command's own default.
 */
export function resolveFeedFormat({
    format,
    terminalDefault,
    stdoutIsTTY,
}: {
    format: string | undefined;
    terminalDefault: FeedFormat;
    stdoutIsTTY: boolean;
}): FeedFormat {
    if (format === undefined) {
        return stdoutIsTTY ? terminalDefault : "monitor";
    }

    const known = FEED_FORMATS.find((candidate) => candidate === format);

    if (!known) {
        throw new FriendlyError(`unknown --format "${format}"`, `Use one of: ${FEED_FORMATS.join(", ")}`);
    }

    return known;
}

export function loginStderrAllowed(): boolean {
    return Boolean(process.stderr.isTTY);
}

export function formatReadyEvent(record: AgentRecord, session: string, mode: AgentMode): LoginReadyEvent {
    return {
        type: "ready",
        agent_id: record.agent_id,
        agent_name: record.agent_name,
        session,
        mode,
        is_main: record.is_main,
    };
}

export async function writeLoginJsonLine(value: unknown): Promise<void> {
    const text = typeof value === "string" ? value : SafeJSON.stringify(value, { strict: true });
    await writeStdout(asResult(text));
}
