/** Port of chrome-har lib/util.js (v1.3.1, MIT). Behavior kept 1:1; `debug` → repo logger. */
import { parse } from "node:url";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { HarNameValue, HarPostData } from "./types.ts";

const log = logger.child({ component: "chrome-devtools:har" });

export function isHttp1x(version: string): boolean {
    return version.toLowerCase().startsWith("http/1.");
}

export function formatMillis(time: number, fractionalDigits = 3): number {
    return Number(Number(time).toFixed(fractionalDigits));
}

export function toNameValuePairs(object: Record<string, unknown>): HarNameValue[] {
    return Object.keys(object).reduce<HarNameValue[]>((result, name) => {
        const value = object[name];

        return Array.isArray(value)
            ? result.concat(value.map((v) => ({ name, value: String(v) })))
            : result.concat([{ name, value: String(value) }]);
    }, []);
}

export function parseUrlEncoded(data: string): HarNameValue[] {
    const params = parse(`?${data}`, true).query;

    return toNameValuePairs(params);
}

export function parsePostData(contentType: string, postData: string | undefined): HarPostData | undefined {
    if (!contentType || !postData) {
        return undefined;
    }

    try {
        if (/^application\/x-www-form-urlencoded/.test(contentType)) {
            return { mimeType: contentType, params: parseUrlEncoded(postData) };
        }

        if (/^application\/json/.test(contentType)) {
            return {
                mimeType: contentType,
                params: toNameValuePairs(SafeJSON.parse(postData, { strict: true }) as Record<string, unknown>),
            };
        }
    } catch {
        log.debug({ contentType }, "unable to parse post data; falling back to text");
    }

    return { mimeType: contentType, text: postData };
}

export function isSupportedProtocol(url: string): boolean {
    return /^https?:/.test(url);
}
