import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { TvSession } from "./types";
import { TV_ORIGIN } from "./ws";

export interface ChartLayout {
    id: string;
    name: string;
    symbol: string;
    resolution: string;
    modified: string;
    studyCount?: number;
}

export interface LayoutStudy {
    name: string;
    pineId?: string;
    pineVersion?: string;
    inputs: Record<string, unknown>;
}

function headers(session: TvSession): Record<string, string> {
    return { cookie: session.cookie, origin: TV_ORIGIN };
}

function decodeMetaIdPart(encoded: string): string {
    try {
        return decodeURIComponent(encoded);
    } catch {
        return encoded.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    }
}

function pineIdFromMetaInfo(metaInfo: string): { pineId?: string; pineVersion?: string } {
    const script = String(metaInfo).match(
        /^(?:Script|StrategyScript)\$(STD|PUB|USER);([^@]+)@(?:[^[]+)(?:\[v\.([^\]]+)\])?/
    );
    if (script) {
        return {
            pineId: `${script[1]};${decodeMetaIdPart(script[2])}`,
            pineVersion: script[3],
        };
    }

    const builtin = String(metaInfo).match(/^([^@]+)@/);
    if (builtin) {
        return { pineId: `STD;${builtin[1]}` };
    }

    return {};
}

function cleanLayoutInputs(inputs: Record<string, unknown>): Record<string, unknown> {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inputs)) {
        if (key === "pineId" || key === "pineVersion" || key === "text" || key === "pineFeatures") {
            continue;
        }

        if (key.startsWith("__")) {
            continue;
        }

        cleaned[key] = value;
    }

    return cleaned;
}

export function mapLayoutList(data: unknown): ChartLayout[] {
    if (!Array.isArray(data)) {
        return [];
    }

    return data
        .map((row) => {
            const entry = row as Record<string, unknown>;
            return {
                id: String(entry.image_url ?? entry.url ?? entry.uid ?? ""),
                name: String(entry.name ?? ""),
                symbol: String(entry.pro_symbol ?? entry.symbol ?? ""),
                resolution: String(entry.resolution ?? entry.interval ?? ""),
                modified: String(entry.modified ?? ""),
            };
        })
        .filter((layout) => layout.id.length > 0);
}

export function mapLayoutStudies(data: unknown): LayoutStudy[] {
    const envelope = data as { content?: string; content_study_meta?: string };
    if (!envelope.content) {
        return [];
    }

    const content = SafeJSON.parse(envelope.content, { strict: true }) as {
        charts?: Array<{
            panes?: Array<{
                sources?: Array<{
                    type?: string;
                    metaInfo?: string;
                    state?: { inputs?: Record<string, unknown> };
                }>;
            }>;
        }>;
    };
    const studyMeta = envelope.content_study_meta
        ? (SafeJSON.parse(envelope.content_study_meta, { strict: true }) as Record<
              string,
              { description?: string; shortDescription?: string }
          >)
        : {};

    const studies: LayoutStudy[] = [];
    const seen = new Set<string>();

    for (const chart of content.charts ?? []) {
        for (const pane of chart.panes ?? []) {
            for (const src of pane.sources ?? []) {
                const type = String(src.type ?? "");
                if (type !== "Study" && !type.startsWith("study_")) {
                    continue;
                }

                const metaKey = String(src.metaInfo ?? "");
                const meta = studyMeta[metaKey];
                const rawInputs = src.state?.inputs ?? {};
                const inputs = cleanLayoutInputs(rawInputs);
                const fromMeta = pineIdFromMetaInfo(metaKey);
                const pineId =
                    (typeof rawInputs.pineId === "string" && rawInputs.pineId.length > 0
                        ? rawInputs.pineId
                        : undefined) ?? fromMeta.pineId;
                const pineVersion =
                    (typeof rawInputs.pineVersion === "string" && rawInputs.pineVersion.length > 0
                        ? rawInputs.pineVersion
                        : undefined) ?? fromMeta.pineVersion;
                const name = meta?.shortDescription || meta?.description || metaKey || type;
                const dedupeKey = `${pineId ?? name}@${SafeJSON.stringify(inputs, { strict: true }) ?? ""}`;
                if (seen.has(dedupeKey)) {
                    continue;
                }

                seen.add(dedupeKey);
                studies.push({
                    name,
                    pineId,
                    pineVersion,
                    inputs,
                });
            }
        }
    }

    return studies;
}

export async function listLayouts(session: TvSession, limit = 100): Promise<ChartLayout[]> {
    const url = `${TV_ORIGIN}/my-charts/?limit=${limit}`;
    logger.debug({ url }, "tradingview: list layouts");
    const res = await fetch(url, { headers: headers(session) });
    if (!res.ok) {
        throw new Error(`my-charts HTTP ${res.status}`);
    }

    const data = SafeJSON.parse(await res.text(), { strict: true });
    return mapLayoutList(data);
}

export async function getLayoutStudies(session: TvSession, layoutId: string): Promise<LayoutStudy[]> {
    const url = `${TV_ORIGIN}/chart/${encodeURIComponent(layoutId)}/json/`;
    logger.debug({ url, layoutId }, "tradingview: get layout studies");
    const res = await fetch(url, { headers: headers(session) });
    if (!res.ok) {
        throw new Error(`chart layout JSON HTTP ${res.status} for ${layoutId}`);
    }

    const data = SafeJSON.parse(await res.text(), { strict: true });
    return mapLayoutStudies(data);
}
