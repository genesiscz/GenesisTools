import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { StandardScript } from "./indicator-aliases";
import type { PineInput, PinePlot, StudyMeta } from "./types";
import { TV_ORIGIN } from "./ws";

const PINE_FACADE = "https://pine-facade.tradingview.com/pine-facade";
const SCRIPT_URL_RE = /tradingview\.com\/script\/([A-Za-z0-9]+)(?:-|\/|$)/;

export interface ScriptSpec {
    pineId: string;
}

/** "PUB;x" | "STD;x" | "USER;x" | script-page URL -> spec; free text -> null (alias path). */
export function parseScriptSpec(raw: string): ScriptSpec | null {
    const trimmed = raw.trim();
    if (/^(STD|PUB|USER);/.test(trimmed)) {
        return { pineId: trimmed };
    }

    const urlMatch = trimmed.match(SCRIPT_URL_RE);
    if (urlMatch) {
        return { pineId: `PUB;${urlMatch[1]}` };
    }

    return null;
}

interface TranslateEnvelope {
    success?: boolean;
    reason?: string;
    result?: {
        ilTemplate?: string;
        metaInfo?: {
            scriptIdPart?: string;
            description?: string;
            shortDescription?: string;
            pine?: { version?: string };
            inputs?: Array<{
                id?: string;
                name?: string;
                type?: string;
                defval?: unknown;
                options?: string[];
                isHidden?: boolean;
                isFake?: boolean;
            }>;
            plots?: Array<{ id?: string; type?: string }>;
            styles?: Record<string, { title?: string }>;
        };
    };
}

export function mapTranslateResponse(data: TranslateEnvelope): StudyMeta {
    const result = data.result;
    const meta = result?.metaInfo;
    if (!data.success || !result?.ilTemplate || !meta) {
        throw new Error(`pine-facade translate failed: ${data.reason ?? "missing result/metaInfo"}`);
    }

    const inputs: PineInput[] = (meta.inputs ?? [])
        .filter((i) => !i.isFake && !i.isHidden && i.id !== "text" && i.id !== "pineId" && i.id !== "pineVersion")
        .map((i) => ({
            id: i.id ?? "",
            name: i.name ?? i.id ?? "",
            type: i.type ?? "text",
            defval: i.defval,
            options: i.options,
        }));
    const plots: PinePlot[] = (meta.plots ?? []).map((p) => ({
        id: p.id ?? "",
        type: p.type ?? "line",
        title: meta.styles?.[p.id ?? ""]?.title ?? p.id ?? "",
    }));

    return {
        pineId: meta.scriptIdPart ?? "",
        pineVersion: meta.pine?.version ?? "1.0",
        description: meta.description ?? "",
        shortDescription: meta.shortDescription ?? "",
        ilTemplate: result.ilTemplate,
        inputs,
        plots,
    };
}

interface PubScriptRef {
    scriptIdPart: string;
    version: string;
}

interface PubSearchRow {
    imageUrl?: string;
    scriptIdPart?: string;
    version?: string;
}

/** Publication slugs (imageUrl) are short; internal scriptIdPart hashes are long. */
function publicationSlugPart(pineId: string): string | null {
    const match = pineId.match(/^PUB;([A-Za-z0-9]+)$/);
    if (!match) {
        return null;
    }

    const part = match[1];
    if (part.length >= 24) {
        return null;
    }

    return part;
}

async function searchPubScripts(query: string, cookie?: string): Promise<PubSearchRow[]> {
    const url = `https://www.tradingview.com/pubscripts-suggest-json/?search=${encodeURIComponent(query)}`;
    logger.debug({ url }, "tradingview: pubscripts search");
    const res = await fetch(url, { headers: { origin: TV_ORIGIN, ...(cookie ? { cookie } : {}) } });
    if (!res.ok) {
        return [];
    }

    const data = SafeJSON.parse(await res.text(), { strict: true }) as { results?: PubSearchRow[] };
    return data.results ?? [];
}

function uniquePubIds(html: string): string[] {
    return [...new Set([...html.matchAll(/PUB;[A-Za-z0-9]+/g)].map((match) => match[0]))];
}

function titleSearchQuery(html: string): string | null {
    const ogTitle = html.match(/property="og:title" content="([^"]+)"/)?.[1];
    if (ogTitle) {
        return ogTitle.split("—")[0]?.trim() ?? null;
    }

    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    if (title) {
        return title.split("—")[0]?.trim() ?? null;
    }

    return null;
}

async function fetchScriptPage(slug: string, cookie?: string): Promise<string | null> {
    const url = `https://www.tradingview.com/script/${slug}/`;
    logger.debug({ url, slug }, "tradingview: fetching publication script page");
    const res = await fetch(url, { headers: { origin: TV_ORIGIN, ...(cookie ? { cookie } : {}) } });
    if (!res.ok) {
        return null;
    }

    return res.text();
}

function pickSearchHit(slug: string, rows: PubSearchRow[]): PubSearchRow | undefined {
    return rows.find((row) => row.imageUrl === slug);
}

/** Map PUB;{publication-slug} to the internal scriptIdPart used by pine-facade translate. */
export async function resolvePubScriptRef(pineId: string, cookie?: string): Promise<PubScriptRef> {
    const slug = publicationSlugPart(pineId);
    if (!slug) {
        return { scriptIdPart: pineId, version: "last" };
    }

    let hit = pickSearchHit(slug, await searchPubScripts(slug, cookie));
    if (hit?.scriptIdPart) {
        return { scriptIdPart: hit.scriptIdPart, version: hit.version ?? "last" };
    }

    const html = await fetchScriptPage(slug, cookie);
    if (html) {
        const loneId = uniquePubIds(html);
        if (loneId.length === 1) {
            return { scriptIdPart: loneId[0]!, version: "last" };
        }

        const query = titleSearchQuery(html);
        if (query) {
            hit = pickSearchHit(slug, await searchPubScripts(query, cookie));
            if (hit?.scriptIdPart) {
                return { scriptIdPart: hit.scriptIdPart, version: hit.version ?? "last" };
            }
        }
    }

    throw new Error(`Could not resolve publication slug PUB;${slug} to an internal script id`);
}

export async function translateIndicator({
    pineId,
    version = "last",
    cookie,
}: {
    pineId: string;
    version?: string;
    cookie?: string;
}): Promise<StudyMeta> {
    const slug = publicationSlugPart(pineId);
    const resolved = await resolvePubScriptRef(pineId, cookie);
    const translateVersion = version === "last" ? resolved.version : version;
    const url = `${PINE_FACADE}/translate/${encodeURIComponent(resolved.scriptIdPart)}/${encodeURIComponent(translateVersion)}`;
    logger.debug({ url, pineId, scriptIdPart: resolved.scriptIdPart }, "tradingview: pine-facade translate");
    const res = await fetch(url, {
        headers: { origin: TV_ORIGIN, ...(cookie ? { cookie } : {}) },
    });

    if (!res.ok) {
        throw new Error(`pine-facade translate HTTP ${res.status} for ${pineId}`);
    }

    const data = SafeJSON.parse(await res.text(), { strict: true }) as TranslateEnvelope;
    const meta = mapTranslateResponse(data);

    // create_study expects the publication slug the user passed, not the internal hash.
    if (slug) {
        return { ...meta, pineId };
    }

    return meta;
}

export async function isAuthToGet({
    pineId,
    version = "last",
    cookie,
}: {
    pineId: string;
    version?: string;
    cookie?: string;
}): Promise<boolean> {
    const resolved = await resolvePubScriptRef(pineId, cookie);
    const checkVersion = version === "last" ? resolved.version : version;
    const url = `${PINE_FACADE}/is_auth_to_get/${encodeURIComponent(resolved.scriptIdPart)}/${encodeURIComponent(checkVersion)}`;
    const res = await fetch(url, { headers: { origin: TV_ORIGIN, ...(cookie ? { cookie } : {}) } });
    if (!res.ok) {
        logger.debug({ status: res.status, pineId }, "tradingview: is_auth_to_get non-OK");
        return false;
    }

    const body = (await res.text()).trim();
    return body === "true" || body.includes('"auth":true') || body.includes("true");
}

export type IndicatorFilter = "standard" | "saved" | "favorites";

export function mapIndicatorList(raw: unknown): StandardScript[] {
    if (!Array.isArray(raw)) {
        return [];
    }

    return raw
        .map((entry) => {
            const row = entry as Record<string, unknown>;
            return {
                scriptIdPart: String(row.scriptIdPart ?? ""),
                scriptName: String(row.scriptName ?? row.scriptTitle ?? ""),
                version: String(row.version ?? "last"),
            };
        })
        .filter((script) => script.scriptIdPart.length > 0);
}

export async function listIndicators({
    filter = "standard",
    cookie,
}: {
    filter?: IndicatorFilter;
    cookie?: string;
}): Promise<StandardScript[]> {
    const url =
        filter === "standard"
            ? `${PINE_FACADE}/list/?filter=standard`
            : `${PINE_FACADE}/list?filter=${encodeURIComponent(filter)}`;
    logger.debug({ url, filter }, "tradingview: pine-facade list");
    const res = await fetch(url, {
        headers: { origin: TV_ORIGIN, ...(cookie ? { cookie } : {}) },
    });
    if (!res.ok) {
        throw new Error(`pine-facade list HTTP ${res.status} for filter=${filter}`);
    }

    const data = SafeJSON.parse(await res.text(), { strict: true });
    return mapIndicatorList(data);
}
