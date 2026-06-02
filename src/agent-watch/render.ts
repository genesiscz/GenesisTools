import { formatTable } from "@app/utils/table";
import pc from "picocolors";
import type { AgentSnapshot } from "./types";

function fmtAge(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));

    if (s < 60) {
        return `${s}s`;
    }

    if (s < 3600) {
        return `${Math.round(s / 60)}m`;
    }

    return `${Math.round(s / 3600)}h`;
}

function colorState(state: AgentSnapshot["state"]): string {
    switch (state) {
        case "FINISHED": {
            return pc.green(state);
        }

        case "STALLED": {
            return pc.yellow(state);
        }

        case "AWAITING-INPUT": {
            return pc.magenta(state);
        }

        default: {
            return pc.cyan(state);
        }
    }
}

export function renderStatusTable(snapshots: AgentSnapshot[]): string {
    if (snapshots.length === 0) {
        return "no agents tracked";
    }

    const rows = snapshots.map((s) => [
        s.name,
        s.source,
        colorState(s.state) + (s.exitCode !== undefined ? ` (${s.exitCode})` : ""),
        fmtAge(s.ageMs),
        (s.lastLine ?? "").slice(0, 48),
    ]);

    return formatTable(rows, ["NAME", "SOURCE", "STATE", "AGE", "LAST OUTPUT"]);
}

export function toJsonSnapshot(snapshots: AgentSnapshot[], now: number): { now: number; agents: AgentSnapshot[] } {
    return { now, agents: snapshots };
}
