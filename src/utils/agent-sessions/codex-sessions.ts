import type { Database } from "bun:sqlite";
import { createNativeHistoryAdapter } from "./native-adapter";
import type { AgentSessionAdapter } from "./types";

export function createCodexAdapter(roots?: string[], database?: Database): AgentSessionAdapter {
    return createNativeHistoryAdapter({ kind: "codex", roots, database });
}
