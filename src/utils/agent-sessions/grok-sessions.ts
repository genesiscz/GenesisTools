import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { nativeSessionRoots } from "@genesiscz/utils/providers/session-paths";
import { createNativeHistoryAdapter } from "./native-adapter";
import type { AgentSessionAdapter } from "./types";

export function grokSessionsRoot(home = homedir()): string {
    return nativeSessionRoots("grok", home)[0] ?? join(home, ".grok", "sessions");
}

export function createGrokAdapter(sessionsRoot?: string, database?: Database): AgentSessionAdapter {
    return createNativeHistoryAdapter({
        kind: "grok",
        roots: sessionsRoot ? [sessionsRoot] : undefined,
        database,
    });
}
