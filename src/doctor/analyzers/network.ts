import { Analyzer } from "@app/doctor/lib/analyzer";
import { run } from "@app/doctor/lib/run";
import type { AnalyzerCategory, AnalyzerContext, ExecutorContext, Finding } from "@app/doctor/lib/types";

const TCP_STATES = [
    "ESTABLISHED",
    "TIME_WAIT",
    "CLOSE_WAIT",
    "LISTEN",
    "SYN_SENT",
    "FIN_WAIT_1",
    "FIN_WAIT_2",
] as const;

export class NetworkAnalyzer extends Analyzer {
    readonly id = "network";
    readonly name = "Network";
    readonly icon = "N";
    readonly category: AnalyzerCategory = "network";
    readonly cacheTtlMs = 0;

    protected async *run(_ctx: AnalyzerContext): AsyncIterable<Finding> {
        const netstatRes = await run("netstat", ["-an"]);
        const counts = netstatRes.status === 0 ? parseNetstatStates(netstatRes.stdout) : {};
        const stuck = (counts.TIME_WAIT ?? 0) + (counts.CLOSE_WAIT ?? 0);

        if (stuck > 100) {
            yield {
                id: "net-stuck-connections",
                analyzerId: this.id,
                title: `${stuck} stuck TCP connections (TIME_WAIT + CLOSE_WAIT)`,
                detail: `TIME_WAIT: ${counts.TIME_WAIT ?? 0} · CLOSE_WAIT: ${counts.CLOSE_WAIT ?? 0}`,
                severity: "safe",
                actions: [],
                metadata: { counts },
            };
        }

        yield {
            id: "net-dns-flush",
            analyzerId: this.id,
            title: "Flush DNS cache",
            detail: "Useful if names are not resolving correctly.",
            severity: "safe",
            actions: [
                {
                    id: "flush-dns",
                    label: "Flush DNS cache",
                    confirm: "yesno",
                    execute: async (_ctx: ExecutorContext, finding) => {
                        const flush = await run("dscacheutil", ["-flushcache"]);
                        // HUP to mDNSResponder requires sudo; skip if non-root to avoid
                        // an interactive password prompt in non-TTY contexts.
                        let hupOk = true;
                        if (process.getuid?.() === 0) {
                            const hup = await run("killall", ["-HUP", "mDNSResponder"]);
                            hupOk = hup.status === 0;
                        }
                        const ok = flush.status === 0 && hupOk;

                        return {
                            findingId: finding.id,
                            actionId: "flush-dns",
                            status: ok ? "ok" : "failed",
                        };
                    },
                },
            ],
        };

        const ifRes = await run("ifconfig", []);
        const utuns = ifRes.status === 0 ? parseUtunInterfaces(ifRes.stdout) : [];

        if (utuns.length > 4) {
            yield {
                id: "net-utun-leftovers",
                analyzerId: this.id,
                title: `${utuns.length} utun interfaces (VPN leftovers?)`,
                detail: "High count suggests stale VPN state. A logout/login usually clears them.",
                severity: "safe",
                actions: [],
                metadata: { count: utuns.length, interfaces: utuns },
            };
        }
    }
}

export function parseNetstatStates(raw: string): Record<string, number> {
    const counts: Record<string, number> = {};
    const statePattern = new RegExp(`\\b(${TCP_STATES.join("|")})\\b`);

    for (const line of raw.split("\n")) {
        const match = line.match(statePattern);
        if (match) {
            const state = match[1];
            counts[state] = (counts[state] ?? 0) + 1;
        }
    }

    return counts;
}

export function parseUtunInterfaces(raw: string): string[] {
    return raw
        .split("\n\n")
        .map((block) => block.match(/^(utun\d+):/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => match[1]);
}
