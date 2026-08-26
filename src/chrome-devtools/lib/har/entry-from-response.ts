/** Port of chrome-har lib/entryFromResponse.js (v1.3.1, MIT). Behavior kept 1:1. */
import { logger } from "@genesiscz/utils/logger";
import { parseRequestCookies, parseResponseCookies } from "./cookies.ts";
import { calculateRequestHeaderSize, calculateResponseHeaderSize, getHeaderValue, parseHeaders } from "./headers.ts";
import type { CdpResourceTiming, CdpResponse, HarBuildOptions, HarEntry, HarPage } from "./types.ts";
import { formatMillis, isHttp1x } from "./util.ts";

const log = logger.child({ component: "chrome-devtools:har" });

function firstNonNegative(values: number[]): number {
    for (const value of values) {
        if (value >= 0) {
            return value;
        }
    }

    return -1;
}

type NumericTimingKey = {
    [K in keyof CdpResourceTiming]-?: CdpResourceTiming[K] extends number ? K : never;
}[keyof CdpResourceTiming];

function parseOptionalTime(timing: CdpResourceTiming, start: NumericTimingKey, end: NumericTimingKey): number {
    if (timing[start] >= 0) {
        return formatMillis(timing[end] - timing[start]);
    }

    return -1;
}

function formatIP(ipAddress: string | undefined): string | undefined {
    if (typeof ipAddress !== "string") {
        return undefined;
    }

    return ipAddress.replaceAll(/^\[|]$/g, "");
}

export function entryFromResponse(
    entry: HarEntry,
    response: CdpResponse,
    page: HarPage,
    options: HarBuildOptions
): void {
    const responseHeaders = response.headers;
    const cookieHeader = getHeaderValue(responseHeaders, "Set-Cookie");

    let cookies = parseResponseCookies(cookieHeader);
    const headers = parseHeaders(responseHeaders);

    if (entry.extraResponseInfo) {
        const blockedCookies = entry.extraResponseInfo.blockedCookies;
        if (blockedCookies) {
            cookies = cookies.filter(
                ({ name }) =>
                    !blockedCookies.some((blockedCookie) => {
                        if (blockedCookie.cookie) {
                            return blockedCookie.cookie.name === name;
                        }

                        if (blockedCookie.cookieLine) {
                            const cookie = parseResponseCookies(blockedCookie.cookieLine)[0];
                            if (cookie) {
                                return cookie.name === name;
                            }
                        }

                        return false;
                    })
            );
        }

        delete entry.extraResponseInfo;
    }

    // response.body must be set by the library user (Network.getResponseBody);
    // it is not part of the CDP Response type.
    const text = options?.includeTextFromResponseBody ? response.body : undefined;

    entry.response = {
        httpVersion: response.protocol,
        redirectURL: "",
        status: response.status,
        statusText: response.statusText,
        content: {
            encoding: response.encoding,
            mimeType: response.mimeType,
            charset: response.charset,
            size: text === undefined ? 0 : text.length,
            text,
        },
        headersSize: -1,
        bodySize: -1,
        cookies,
        headers,
        _transferSize: response.encodedDataLength,
        fromDiskCache: response.fromDiskCache || false,
        fromEarlyHints: response.fromEarlyHints || false,
        fromServiceWorker: response.fromServiceWorker || false,
        fromPrefetchCache: response.fromPrefetchCache || false,
    };

    const locationHeaderValue = getHeaderValue(responseHeaders, "Location");
    if (locationHeaderValue) {
        entry.response.redirectURL = locationHeaderValue;
    }

    entry.request.httpVersion = response.protocol;

    if (response.fromDiskCache === true && response.fromEarlyHints !== true) {
        if (isHttp1x(response.protocol)) {
            // In http2 headers are compressed, so calculating size from headers text wouldn't be correct.
            entry.response.headersSize = calculateResponseHeaderSize(response);
        }

        // h2 push might cause resource to be received before parser sees and requests it.
        if (response.timing && !((response.timing.pushStart ?? 0) > 0)) {
            entry.cache.beforeRequest = { lastAccess: "", eTag: "", hitCount: 0 };
        }
    } else {
        if (response.requestHeaders) {
            entry.request.headers = parseHeaders(response.requestHeaders);
            const requestCookieHeader = getHeaderValue(response.requestHeaders, "Cookie");
            entry.request.cookies = parseRequestCookies(requestCookieHeader);
        }

        if (isHttp1x(response.protocol)) {
            entry.response.headersSize = response.headersText
                ? response.headersText.length
                : calculateResponseHeaderSize(response);
            entry.response.bodySize = response.encodedDataLength - entry.response.headersSize;
            entry.request.headersSize = response.requestHeadersText
                ? response.requestHeadersText.length
                : calculateRequestHeaderSize(entry.request);
        }
    }

    entry.connection = response.connectionId.toString();
    entry.serverIPAddress = formatIP(response.remoteIPAddress);

    const timing = response.timing;
    if (timing) {
        const blocked = formatMillis(firstNonNegative([timing.dnsStart, timing.connectStart, timing.sendStart]));
        const dns = parseOptionalTime(timing, "dnsStart", "dnsEnd");
        const connect = parseOptionalTime(timing, "connectStart", "connectEnd");
        const send = formatMillis(timing.sendEnd - timing.sendStart);
        const wait = formatMillis(timing.receiveHeadersEnd - timing.sendEnd);
        const receive = 0;
        const ssl = parseOptionalTime(timing, "sslStart", "sslEnd");

        entry.timings = { blocked, dns, connect, send, wait, receive, ssl };
        entry._requestTime = timing.requestTime;
        entry.__receiveHeadersEnd = timing.receiveHeadersEnd;

        if ((timing.pushStart ?? 0) > 0) {
            // use the same extended field as WebPageTest
            entry._was_pushed = 1;
        }

        entry.time = Math.max(0, blocked) + Math.max(0, dns) + Math.max(0, connect) + send + wait + receive;

        // Some cached responses generate a Network.requestServedFromCache event,
        // but fromDiskCache is still set to false.
        if (!entry.__servedFromCache) {
            // wallTime is not necessarily monotonic, timestamp is; derive startedDateTime from timestamp diffs.
            const entrySecs = (page.__wallTime ?? 0) + (timing.requestTime - (page.__timestamp ?? 0));
            try {
                entry.startedDateTime = new Date(entrySecs * 1000).toISOString();
            } catch (err) {
                // upstream swallows this too (sitespeed.io#4285): keep the previous startedDateTime
                log.debug({ err, entrySecs }, "startedDateTime out of range");
            }

            const queuedMillis = (timing.requestTime - (entry.__requestWillBeSentTime ?? 0)) * 1000;
            if (queuedMillis > 0) {
                entry.timings._queued = formatMillis(queuedMillis);
            }
        }

        if (entry.cache?.beforeRequest) {
            entry.cache.beforeRequest.lastAccess = entry.startedDateTime;
        }
    } else {
        entry.timings = {
            blocked: -1,
            dns: -1,
            connect: -1,
            send: 0,
            wait: 0,
            receive: 0,
            ssl: -1,
            comment: "No timings available from Chrome",
        };
        entry.time = 0;
    }
}
