import type { AgentHostMarker } from "@genesiscz/utils/ai/active-processes";
import { readT3Thread } from "./thread-env";

/**
 * How a process shows that T3 Code started it. T3 Code sets its thread on a Claude child only; a Codex app-server or a
 * Grok ACP process serves its threads without one, and every child gets `T3CODE_CLI_PATH` (checked 2026-11-01). The
 * thread is read by its one reader (`readT3Thread`), so the identity and the process rows read it alike. The plugin's
 * pin hook keeps a copy (`plugins/genesis-tools/hooks/record-session-account.ts`), pinned by record-hook.test.ts.
 */
export const T3_HOST_MARKERS: readonly AgentHostMarker[] = [
    { kind: "t3", envKey: "T3CODE_THREAD_ID", carriesId: true, read: readT3Thread },
    { kind: "t3", envKey: "T3CODE_CLI_PATH", carriesId: false },
];
