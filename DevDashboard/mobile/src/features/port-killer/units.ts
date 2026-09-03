import type { PortInfo } from "@dd/contract";

/**
 * Pure formatters for the port-killer screen. Reimplemented locally (NOT imported from `@app/*`) so
 * the RN bundle never drags web/server code in. Pure logic only — runs under `bun:test`.
 */

export function portLabel(port: number): string {
    return `:${port}`;
}

export function protoLabel(proto: PortInfo["proto"]): string {
    return proto === "tcp6" ? "IPv6" : "IPv4";
}

/** Stable sort by port ascending, then proto — already server-sorted, but keep the UI deterministic. */
export function byPortAsc(ports: PortInfo[]): PortInfo[] {
    return [...ports].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}
