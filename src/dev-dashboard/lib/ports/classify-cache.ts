import type { PortInfo } from "@app/dev-dashboard/lib/ports/types";

export function portIdentity(p: Pick<PortInfo, "port" | "pid" | "command" | "fullCommand" | "startedAt">): string {
    return [p.port, p.pid, p.fullCommand ?? p.command ?? "", p.startedAt ?? ""].join("|");
}

interface Cached {
    kind: NonNullable<PortInfo["kind"]>;
    isWebapp?: boolean;
    title?: string;
}

const cache = new Map<string, Cached>();

/** Apply cached kinds so unchanged listeners skip HTTP probe. */
export function applyClassifyCache(ports: PortInfo[]): PortInfo[] {
    return ports.map((p) => {
        if (p.probeStatus !== "pending") {
            return p;
        }

        const hit = cache.get(portIdentity(p));
        if (!hit) {
            return p;
        }

        return {
            ...p,
            kind: hit.kind,
            isWebapp: hit.isWebapp ?? p.isWebapp,
            title: p.title ?? hit.title,
            probeStatus: "done",
        };
    });
}

export function rememberClassify(ports: PortInfo[]): void {
    for (const p of ports) {
        if (p.probeStatus !== "done" && p.probeStatus !== "skipped") {
            continue;
        }

        if (!p.kind) {
            continue;
        }

        cache.set(portIdentity(p), {
            kind: p.kind,
            isWebapp: p.isWebapp,
            title: p.title,
        });
    }
}

export function clearClassifyCache(): void {
    cache.clear();
}
