import { collapseDualStack, filterPortsByKind, type PortFilterId } from "@app/dev-dashboard/lib/ports/classify";
import type { PortInfo } from "@app/dev-dashboard/lib/ports/types";

/**
 * Pick the listening web apps from a scan: keep HTTP responders, collapse the tcp4/tcp6 pair for a port
 * into one row (prefer IPv4), sort ascending by port. PURE and dependency-free so the browser UI can
 * import it without pulling the Node logger into the client bundle.
 */
export function selectWebapps(ports: PortInfo[]): PortInfo[] {
    const byPort = new Map<number, PortInfo>();

    for (const p of ports) {
        if (!p.isWebapp && p.kind !== "web") {
            continue;
        }

        const existing = byPort.get(p.port);
        if (!existing || (existing.proto === "tcp6" && p.proto === "tcp4")) {
            byPort.set(p.port, p);
        }
    }

    return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/**
 * Main-dashboard list: collapse dual-stack, apply kind multiselect, exclude system/junk
 * (caller can pass includeHidden for the expandable footer).
 */
export function selectPortsForPanel(
    ports: PortInfo[],
    opts: { filters: PortFilterId[]; includeHidden?: boolean }
): PortInfo[] {
    const collapsed = collapseDualStack(ports);
    const visible = opts.includeHidden
        ? collapsed
        : collapsed.filter((p) => p.visibility !== "system" && p.visibility !== "junk");

    return filterPortsByKind(visible, opts.filters);
}
