/**
 * The preflight context: what a session works on, with how each fact was found. It reports; the model connects the
 * dots. It writes nothing except a binding (`bindContext`).
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { peekPrLookupCache } from "@genesiscz/utils/git/origins/lookup-cache";
import type { PrInfo } from "@genesiscz/utils/git/origins/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import type { ContextStamp } from "../model/change";
import type { Actor } from "../model/item";
import { isOpenState } from "../model/vocab";
import { selectClaims, selectItem } from "../store/rows";

const log = logger.child({ component: "agent-context" });

export type FactMethod = "given" | "read" | "inferred";

export interface ContextFact {
    provider: string;
    /** What the fact is about: `handoff`, `pr`, `bound.improve`, `tracker`. */
    path: string;
    value: string;
    how: { method: FactMethod; source: string; evidence: string; strength?: "strong" | "weak" };
}

export interface ContextView {
    actor: Actor;
    /** The caller's own session, then its lead's (a T3 parent thread's session). */
    lineage: string[];
    branch: string | null;
    head: string | null;
    originUrl: string | null;
    network: boolean;
    db: Database;
    bindings: Binding[];
    /** A PR lookup over the network; only called with `network` set. */
    fetchPr?: () => Promise<PrInfo | null>;
}

export interface ContextProvider {
    id: string;
    cost: "local" | "network";
    find(view: ContextView): Promise<ContextFact[]>;
}

export const BIND_KINDS = ["improve", "plan"] as const;
export type BindKind = (typeof BIND_KINDS)[number];

export interface Binding {
    kind: BindKind;
    target: string;
    ts: string;
}

const ITEM_ID_IN_TEXT = /\b[hw]_[a-z0-9]{8}\b/g;

const claimed: ContextProvider = {
    id: "claimed",
    cost: "local",
    async find(view) {
        const facts: ContextFact[] = [];

        view.lineage.forEach((session, index) => {
            for (const claim of selectClaims(view.db, { sessionIds: [session], active: true })) {
                const item = selectItem(view.db, claim.item);

                if (item === null || !isOpenState(item.state)) {
                    continue;
                }

                facts.push({
                    provider: "claimed",
                    path: "handoff",
                    value: item.id,
                    how: {
                        method: "read",
                        source: "work.claims",
                        evidence: `${index === 0 ? "this session" : `lead session ${session}`} claimed ${item.id} (${item.title}) at ${claim.ts}`,
                    },
                });
            }
        });

        if (view.branch !== null) {
            const named = [...new Set(view.branch.match(ITEM_ID_IN_TEXT) ?? [])];

            for (const id of named) {
                const item = selectItem(view.db, id);

                if (item !== null && isOpenState(item.state)) {
                    facts.push({
                        provider: "claimed",
                        path: "handoff",
                        value: item.id,
                        how: {
                            method: "inferred",
                            source: "git.branch",
                            evidence: `the branch ${view.branch} names ${item.id}`,
                            strength: named.length === 1 ? "strong" : "weak",
                        },
                    });
                }
            }
        }

        return facts;
    },
};

const pr: ContextProvider = {
    id: "pr",
    cost: "local",
    async find(view) {
        if (view.branch === null || view.head === null || view.originUrl === null) {
            return [];
        }

        if (view.network && view.fetchPr !== undefined) {
            const found = await view.fetchPr();
            return found === null
                ? []
                : [
                      {
                          provider: "pr",
                          path: "pr",
                          value: found.url,
                          how: {
                              method: "read",
                              source: "forge",
                              evidence: `#${found.number} ${found.state}, base ${found.target}`,
                          },
                      },
                  ];
        }

        const cached = peekPrLookupCache({ originUrl: view.originUrl, branch: view.branch, head: view.head });

        if (cached === null || cached.pr === null) {
            return [];
        }

        const ageMinutes = Math.round((Date.now() - cached.cachedAt) / 60_000);
        return [
            {
                provider: "pr",
                path: "pr",
                value: cached.pr.url,
                how: {
                    method: "read",
                    source: "pr-lookup-cache",
                    evidence: `#${cached.pr.number} ${cached.pr.state}, base ${cached.pr.target}, cached ${ageMinutes} min ago`,
                },
            },
        ];
    },
};

/** The tracker connector's own lookup arrives with the connectors (P5). */
const tracker: ContextProvider = {
    id: "tracker",
    cost: "network",
    async find() {
        return [];
    },
};

const bound: ContextProvider = {
    id: "bound",
    cost: "local",
    async find(view) {
        return view.bindings.map((binding) => ({
            provider: "bound",
            path: `bound.${binding.kind}`,
            value: binding.target,
            how: { method: "given", source: "tools agents context bind", evidence: `bound at ${binding.ts}` },
        }));
    },
};

export const CONTEXT_PROVIDERS = { pr, claimed, tracker, bound } satisfies Record<string, ContextProvider>;

export interface ContextReport {
    current: Record<string, ContextFact>;
    candidates: ContextFact[];
}

const RANK: Record<FactMethod, number> = { given: 0, read: 1, inferred: 2 };

/** `current` takes, per path: given, read, then an inferred fact only when it is strong and the single answer. */
export function pickCurrent(facts: readonly ContextFact[]): ContextReport {
    const byPath = new Map<string, ContextFact[]>();

    for (const fact of facts) {
        byPath.set(fact.path, [...(byPath.get(fact.path) ?? []), fact]);
    }

    const current: Record<string, ContextFact> = {};
    const candidates: ContextFact[] = [];

    for (const [path, list] of byPath) {
        const sorted = [...list].sort((a, b) => RANK[a.how.method] - RANK[b.how.method]);
        const best = sorted[0];
        const sameRank = sorted.filter((f) => RANK[f.how.method] === RANK[best.how.method]);
        const distinct = new Set(sameRank.map((f) => f.value));
        const usable = best.how.method !== "inferred" || (best.how.strength === "strong" && distinct.size === 1);

        if (usable && distinct.size === 1) {
            current[path] = best;
            candidates.push(...sorted.filter((f) => f !== best && f.value !== best.value));
        } else {
            candidates.push(...sorted);
        }
    }

    return { current, candidates };
}

export async function gatherContext(
    view: ContextView,
    providers: readonly ContextProvider[] = Object.values(CONTEXT_PROVIDERS)
): Promise<ContextReport> {
    const facts: ContextFact[] = [];

    for (const provider of providers) {
        if (provider.cost === "network" && !view.network) {
            continue;
        }

        try {
            facts.push(...(await provider.find(view)));
        } catch (error) {
            log.warn({ err: error, provider: provider.id }, "agent-context: a provider failed; its facts are missing");
        }
    }

    for (const fact of facts) {
        if (fact.how.method === "inferred") {
            log.info(
                {
                    path: fact.path,
                    value: fact.value,
                    rule: fact.how.source,
                    evidence: fact.how.evidence,
                    strength: fact.how.strength,
                },
                "agent-context: inferred a fact"
            );
        }
    }

    return pickCurrent(facts);
}

/** The stamp a write keeps in its journal entry: the current facts it used. */
export function stampOf(report: ContextReport): ContextStamp {
    return {
        facts: Object.values(report.current).map((fact) => ({
            path: fact.path,
            value: fact.value,
            method: fact.how.method,
            source: fact.how.source,
        })),
    };
}

function bindingsPath(sessionId: string): string {
    return genesisToolsDir("work", "bindings", `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
}

export function readBindings(sessionId: string | null): Binding[] {
    if (sessionId === null) {
        return [];
    }

    const path = bindingsPath(sessionId);

    if (!existsSync(path)) {
        return [];
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8")) as { bindings?: Binding[] };
        return Array.isArray(parsed.bindings) ? parsed.bindings : [];
    } catch (error) {
        log.warn({ err: error, path }, "agent-context: the bindings file is unreadable; no binding is used");
        return [];
    }
}

/** The one write of the context: a session declares what it works for (`--kind improve --target <text>`). */
export function bindContext(sessionId: string, binding: Binding): Binding[] {
    const next = [...readBindings(sessionId).filter((b) => b.kind !== binding.kind), binding];
    const path = bindingsPath(sessionId);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${SafeJSON.stringify({ version: 1, bindings: next }, null, 2)}\n`);
    return next;
}
