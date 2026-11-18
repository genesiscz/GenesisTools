import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { LoopContext } from "@genesiscz/utils/agent-sessions/analysis-types";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { appendSpoolLines, spoolLine } from "@genesiscz/utils/metrics/spool";
import { formatTable } from "@genesiscz/utils/table";

const pushed = new Set([
    "hook",
    "hook-block",
    "instructions",
    "rule-file",
    "skill_listing",
    "mcp_instructions_delta",
    "deferred_tools_delta",
    "agent_listing_delta",
    "system-prompt+tools",
    "session_context",
    "environment",
]);

function bySource(loops: LoopContext[]) {
    const groups = new Map<
        string,
        { source: string; key: string; tokens: number; carry: number; items: number; loops: number }
    >();
    for (const loop of loops) {
        const seen = new Set<string>();
        for (const item of loop.items) {
            const key = `${item.source}\0${item.key}`;
            const group = groups.get(key) ?? {
                source: item.source,
                key: item.key,
                tokens: 0,
                carry: 0,
                items: 0,
                loops: 0,
            };
            group.tokens += item.tokens;
            group.carry += item.tokens * item.carryCalls;
            group.items++;
            if (!seen.has(key)) {
                group.loops++;
                seen.add(key);
            }
            groups.set(key, group);
        }
    }
    return [...groups.values()].sort((a, b) => b.carry - a.carry);
}

export function contextReport(loops: LoopContext[], largest: number) {
    const agents = loops.filter((loop) => loop.kind !== "main");
    const types = new Map<
        string,
        {
            kind: string;
            type: string | null;
            model: string | null;
            agents: number;
            measured: number;
            first: number;
            cacheRead: number;
        }
    >();
    for (const loop of agents) {
        const key = SafeJSON.stringify([loop.kind, loop.agentType, loop.model]);
        const row = types.get(key) ?? {
            kind: loop.kind,
            type: loop.agentType,
            model: loop.model,
            agents: 0,
            measured: 0,
            first: 0,
            cacheRead: 0,
        };
        row.agents++;
        if (loop.firstCallContext !== null) {
            row.measured++;
            row.first += loop.firstCallContext;
        }
        row.cacheRead += loop.cacheRead;
        types.set(key, row);
    }

    const mainBySource = bySource(loops.filter((loop) => loop.kind === "main"));
    const agentsBySource = bySource(agents);
    const largestItems =
        largest === 0
            ? []
            : loops
                  .flatMap((loop) =>
                      loop.items.map((item) => ({
                          loop: loop.id,
                          kind: loop.kind,
                          ...item,
                          carry: item.tokens * item.carryCalls,
                      }))
                  )
                  .sort((a, b) => b.carry - a.carry)
                  .slice(0, largest);
    return {
        loops: loops.map(({ items, ...facts }) => ({ ...facts, itemCount: items.length })),
        mainBySource,
        agentsBySource,
        mainPushed: mainBySource.filter((row) => pushed.has(row.source)),
        agentsPushed: agentsBySource.filter((row) => pushed.has(row.source)),
        startByType: [...types.values()].map(({ first, ...row }) => ({
            ...row,
            meanFirstContext: row.measured ? first / row.measured : null,
        })),
        agentsByCacheRead: [...agents]
            .sort((a, b) => b.cacheRead - a.cacheRead)
            .map(({ items, ...facts }) => ({ ...facts, itemCount: items.length })),
        largestItems,
    };
}

export function spoolContextItems(options: { sessionId: string; loops: LoopContext[]; dir?: string }) {
    const snapshot = randomUUID();
    const exportedAt = Date.now();
    const lines: string[] = [];
    let events = 0;
    const flush = () => {
        appendSpoolLines({ writer: "session-context", dir: options.dir, lines });
        lines.length = 0;
    };
    for (const loop of options.loops) {
        for (const item of loop.items) {
            lines.push(
                spoolLine({
                    project: "agent-context",
                    metric: "context.item",
                    value: item.tokens,
                    at: item.at ?? exportedAt,
                    dims: {
                        session: options.sessionId,
                        loop: loop.id,
                        kind: loop.kind,
                        agentType: loop.agentType,
                        model: loop.model,
                        source: item.source,
                        key: item.key,
                        carryCalls: item.carryCalls,
                        snapshot,
                    },
                    context: { path: item.path, line: item.line, at: item.at },
                })
            );
            events++;
            if (lines.length === 256) {
                flush();
            }
        }
    }
    flush();
    return { snapshot, events };
}

interface ContextOptions {
    provider?: AccountProviderAlias;
    agents?: boolean;
    top: number;
    agentsTop: number;
    items: number;
    json?: boolean;
    recordMetrics?: boolean;
    out?: string;
}

function renderContext(report: ReturnType<typeof contextReport>, opts: ContextOptions): string {
    const sections: string[] = [];
    for (const [label, rows] of [
        ["Main loop, every source by carry", report.mainBySource],
        ["Main loop, pushed sources", report.mainPushed],
        ["Agents, every source by carry", report.agentsBySource],
        ["Agents, pushed sources", report.agentsPushed],
    ] as const) {
        sections.push(
            label,
            formatTable(
                rows
                    .slice(0, opts.top)
                    .map((r) => [r.source, r.key, String(r.items), String(r.tokens), String(r.carry), String(r.loops)]),
                ["SOURCE", "KEY", "ITEMS", "EST. TOKENS", "TOKEN-READS", "LOOPS"]
            )
        );
    }
    sections.push(
        "Agent start cost by type",
        formatTable(
            report.startByType.map((r) => [
                r.kind,
                r.type ?? "?",
                r.model ?? "?",
                String(r.agents),
                r.meanFirstContext?.toFixed(0) ?? "?",
            ]),
            ["KIND", "TYPE", "MODEL", "AGENTS", "AVG FIRST CONTEXT"]
        )
    );
    sections.push(
        "Agents by cache read",
        formatTable(
            report.agentsByCacheRead
                .slice(0, opts.agentsTop)
                .map((r) => [r.id, String(r.calls), String(r.cacheRead), String(r.peakContext ?? "?")]),
            ["LOOP", "CALLS", "CACHE READ", "PEAK CONTEXT"]
        )
    );
    sections.push(
        "Largest items by carry",
        formatTable(
            report.largestItems.map((i) => [
                i.loop,
                `${i.path}:${i.line}`,
                i.source,
                i.key,
                String(i.tokens),
                String(i.carryCalls),
                String(i.carry),
            ]),
            ["LOOP", "TRANSCRIPT:LINE (0 = inferred)", "SOURCE", "KEY", "EST. TOKENS", "CALLS", "TOKEN-READS"],
            { maxColWidth: Infinity }
        )
    );
    return sections.join("\n");
}

export async function printContext(ids: string[], opts: ContextOptions): Promise<void> {
    const reports = [];
    const combined: LoopContext[] = [];
    for (const id of ids) {
        const session = await resolveTranscript(id, {}, opts.provider);
        const facts =
            session.source === "native"
                ? await resolveHistoryProvider(session.provider).reader.analysis.contextItems(session.filePath, {
                      agents: opts.agents,
                  })
                : { supported: false as const, reason: "Worker output has no native context-item history" };
        const identity = { schema: "sessions.context@1", sessionId: session.sessionId, provider: session.provider };
        if (!facts.supported) {
            reports.push({ ...identity, supported: false, reason: facts.reason });
            if (!opts.json) {
                out.println(`${session.sessionId}: ${facts.reason}`);
            }
            continue;
        }
        const report = contextReport(facts.items, opts.items);
        const metrics = opts.recordMetrics
            ? spoolContextItems({ sessionId: session.sessionId, loops: facts.items })
            : undefined;
        const result = { ...identity, supported: true, ...report, ...(metrics ? { metrics } : {}) };
        if (opts.json) {
            reports.push(result);
        }
        const rendered = !opts.json || opts.out ? `# ${session.sessionId}\n${renderContext(report, opts)}` : "";
        if (!opts.json) {
            out.println(rendered);
            if (metrics) {
                out.println(`Spooled ${metrics.events} context items, snapshot ${metrics.snapshot}`);
            }
            if (ids.length > 1) {
                combined.push(...facts.items);
            }
        }
        if (opts.out) {
            await mkdir(opts.out, { recursive: true });
            const base = join(opts.out, basename(session.sessionId).slice(0, 8));
            await Bun.write(`${base}.context-sources.json`, SafeJSON.stringify(result));
            await Bun.write(`${base}.context-sources.txt`, `${rendered}\n`);
        }
    }
    if (opts.json) {
        out.result(ids.length === 1 ? reports[0] : reports);
    } else if (combined.length) {
        out.println(`# all ${ids.length} sessions\n${renderContext(contextReport(combined, opts.items), opts)}`);
    }
}
