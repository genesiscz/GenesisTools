import { asResult } from "@genesiscz/utils/cli/result";
import { writeStdout } from "@genesiscz/utils/cli/stdout";
import { SafeJSON } from "@genesiscz/utils/json";
import type { AgentMode, AgentRecord } from "./types";

export interface LoginReadyEvent {
    type: "ready";
    agent_id: string;
    agent_name: string;
    session: string;
    mode: AgentMode;
    is_main: boolean;
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
