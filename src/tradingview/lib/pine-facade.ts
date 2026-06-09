import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
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

export async function translateIndicator({
    pineId,
    version = "last",
    cookie,
}: {
    pineId: string;
    version?: string;
    cookie?: string;
}): Promise<StudyMeta> {
    const url = `${PINE_FACADE}/translate/${encodeURIComponent(pineId)}/${encodeURIComponent(version)}`;
    logger.debug({ url }, "tradingview: pine-facade translate");
    const res = await fetch(url, {
        headers: { origin: TV_ORIGIN, ...(cookie ? { cookie } : {}) },
    });
    if (!res.ok) {
        throw new Error(`pine-facade translate HTTP ${res.status} for ${pineId}`);
    }

    const data = SafeJSON.parse(await res.text(), { strict: true }) as TranslateEnvelope;
    return mapTranslateResponse(data);
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
    const url = `${PINE_FACADE}/is_auth_to_get/${encodeURIComponent(pineId)}/${encodeURIComponent(version)}`;
    const res = await fetch(url, { headers: { origin: TV_ORIGIN, ...(cookie ? { cookie } : {}) } });
    if (!res.ok) {
        logger.debug({ status: res.status, pineId }, "tradingview: is_auth_to_get non-OK");
        return false;
    }

    const body = (await res.text()).trim();
    return body === "true" || body.includes('"auth":true') || body.includes("true");
}
