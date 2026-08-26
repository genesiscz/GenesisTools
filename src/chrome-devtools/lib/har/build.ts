/**
 * Port of chrome-har index.js (sitespeedio/chrome-har v1.3.1, MIT).
 *
 * Three deliberate deviations from upstream, everything else is 1:1:
 * 1. Entries are matched by a session-scoped key (`sessionId + requestId`)
 *    instead of the bare requestId, so events from several tabs/targets
 *    recorded into one stream cannot silently corrupt each other's entries
 *    (upstream reads no sessionId at all — verified against its source).
 * 2. The requests-buffered-before-any-page arrays are CLEARED once folded
 *    into the first page; upstream re-concats them on every later page,
 *    duplicating those entries.
 * 3. An invalid cookie expiry date renders as no `expires` instead of
 *    crashing `toISOString` (upstream issues #110/#122).
 * 4. When a message carries a sessionId, pages and page timings are attributed
 *    per session (frameId first, then that session's latest page) instead of
 *    upstream's global `pages.at(-1)`. Sessionless messages keep the upstream
 *    behavior exactly.
 *
 * Sessionless single-page input behaves exactly like upstream; the parity
 * test (`build.parity.test.ts`) pins that against the real npm package.
 *
 * Inherited upstream limitation, kept for parity: blocked response cookies are
 * filtered by NAME only (lib/entry-from-response.ts) — when one response sets
 * the same cookie name for two paths and CDP blocks only one, both leave the
 * HAR. Fixing it would diverge from the upstream goldens.
 */

import { randomUUID } from "node:crypto";
import { format, parse } from "node:url";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { formatCookie, parseRequestCookies } from "./cookies.ts";
import { entryFromResponse } from "./entry-from-response.ts";
import { finalizeEntry } from "./finalize-entry.ts";
import { getHeaderValue, parseHeaders } from "./headers.ts";
import type {
    CdpAssociatedCookie,
    CdpMessage,
    CdpRequestWillBeSentParams,
    CdpResponseReceivedExtraInfoParams,
    CdpResponseReceivedParams,
    HarBuildOptions,
    HarEntry,
    HarFile,
    HarPage,
} from "./types.ts";
import { formatMillis, isSupportedProtocol, parsePostData, toNameValuePairs } from "./util.ts";

const log = logger.child({ component: "chrome-devtools:har" });

const PORT_OF_VERSION = "1.3.1";

const defaultOptions: Required<HarBuildOptions> = {
    includeResourcesFromDiskCache: false,
    includeTextFromResponseBody: false,
};

/** Session-scoped match key. Sessionless input degrades to the bare requestId, like upstream. */
function keyOf(sessionId: string | undefined, requestId: string): string {
    return sessionId ? `${sessionId}\u0000${requestId}` : requestId;
}

function deleteInternalProperties<T extends object>(o: T): T {
    // __ properties are only for internal use, _ properties are custom HAR fields.
    for (const prop of Object.keys(o)) {
        if (prop.startsWith("__")) {
            delete (o as Record<string, unknown>)[prop];
        }
    }

    return o;
}

function addFromFirstRequest(page: HarPage, params: CdpRequestWillBeSentParams): void {
    if (!page.__timestamp) {
        page.__wallTime = params.wallTime;
        page.__timestamp = params.timestamp;
        page.startedDateTime = new Date(params.wallTime * 1000).toISOString();
        // URL is better than blank, and it's what devtools uses.
        page.title = page.title === "" ? params.request.url : page.title;
    }
}

export function harFromMessages(messages: CdpMessage[], options?: HarBuildOptions): HarFile {
    const opts = { ...defaultOptions, ...options };

    const ignoredRequests = new Set<string>();
    const rootFrameMappings = new Map<string, string>();

    let pages: HarPage[] = [];
    let entries: HarEntry[] = [];
    const entriesWithoutPage: HarEntry[] = [];
    const responsesWithoutPage: { key: string; params: CdpResponseReceivedParams }[] = [];
    const paramsWithoutPage: { key: string; params: CdpRequestWillBeSentParams }[] = [];
    const responseReceivedExtraInfos: { key: string; params: CdpResponseReceivedExtraInfoParams }[] = [];
    let currentPageId: string | undefined;
    const lastPageBySession = new Map<string, HarPage>();

    const findEntry = (key: string): HarEntry | undefined => entries.find((entry) => entry.__key === key);

    /** Deviation 4: session-scoped page attribution. Sessionless falls back to upstream's `pages.at(-1)`. */
    const pageForRequest = (sessionId: string | undefined, frameId: string | undefined): HarPage | undefined => {
        if (!sessionId) {
            return pages.at(-1);
        }

        if (frameId) {
            const rootFrame = rootFrameMappings.get(frameId) || frameId;
            const byFrame = pages.find((p) => p.__frameId === rootFrame);
            if (byFrame) {
                return byFrame;
            }
        }

        return lastPageBySession.get(sessionId) ?? pages.at(-1);
    };

    const pageForTiming = (sessionId: string | undefined): HarPage | undefined => {
        if (!sessionId) {
            return pages.at(-1);
        }

        return lastPageBySession.get(sessionId) ?? pages.at(-1);
    };

    const populateRedirectResponse = (
        page: HarPage | undefined,
        key: string,
        params: CdpRequestWillBeSentParams
    ): void => {
        const previousEntry = findEntry(key);
        if (previousEntry && params.redirectResponse) {
            previousEntry.__key += "r";
            previousEntry._requestId += "r";
            entryFromResponse(previousEntry, params.redirectResponse, page ?? ({ pageTimings: {} } as HarPage), opts);
        } else {
            log.debug({ requestId: params.requestId }, "no original request for redirect response");
        }
    };

    for (const message of messages) {
        const method = message.method;

        if (!/^(Page|Network|SoftNavigation)\..+/.test(method)) {
            continue;
        }

        switch (method) {
            case "Page.frameStartedLoading":
            case "Page.frameRequestedNavigation":
            case "Page.navigatedWithinDocument": {
                const params = message.params as { frameId: string; url?: string };
                const frameId = params.frameId;
                const rootFrame = rootFrameMappings.get(frameId) || frameId;
                if (pages.some((page) => page.__frameId === rootFrame)) {
                    continue;
                }

                currentPageId = randomUUID();
                const title = method === "Page.navigatedWithinDocument" ? (params.url ?? "") : "";
                const page: HarPage = {
                    id: currentPageId,
                    startedDateTime: "",
                    title,
                    pageTimings: {},
                    __frameId: rootFrame,
                };
                pages.push(page);
                lastPageBySession.set(message.sessionId ?? "", page);

                // do we have any unmapped requests, add them
                if (entriesWithoutPage.length > 0) {
                    for (const entry of entriesWithoutPage) {
                        entry.pageref = page.id;
                    }

                    entries = entries.concat(entriesWithoutPage);
                    entriesWithoutPage.length = 0;
                    if (paramsWithoutPage[0]) {
                        addFromFirstRequest(page, paramsWithoutPage[0].params);
                    }

                    for (const buffered of paramsWithoutPage) {
                        if (buffered.params.redirectResponse) {
                            populateRedirectResponse(page, buffered.key, buffered.params);
                        }
                    }

                    paramsWithoutPage.length = 0;
                }

                if (responsesWithoutPage.length > 0) {
                    for (const buffered of responsesWithoutPage) {
                        const entry = findEntry(buffered.key);
                        if (entry) {
                            entryFromResponse(entry, buffered.params.response, page, opts);
                        } else {
                            log.debug({}, "no matching request for buffered response");
                        }
                    }

                    responsesWithoutPage.length = 0;
                }

                break;
            }

            // Soft navigation events are injected by the caller when a SPA
            // navigation is detected; update the current page instead of
            // creating a new one.
            case "SoftNavigation.detected": {
                const params = message.params as { url?: string };
                const page = pages.at(-1);
                if (page) {
                    page.title = params.url || "";
                    page._softNavigation = true;
                } else {
                    currentPageId = randomUUID();
                    pages.push({
                        id: currentPageId,
                        startedDateTime: "",
                        title: params.url || "",
                        pageTimings: {},
                        _softNavigation: true,
                    });
                }

                break;
            }

            case "Network.requestWillBeSent": {
                const params = message.params as unknown as CdpRequestWillBeSentParams;
                const key = keyOf(message.sessionId, params.requestId);
                const request = params.request;

                if (!isSupportedProtocol(request.url)) {
                    ignoredRequests.add(key);
                    continue;
                }

                const page = pageForRequest(message.sessionId, params.frameId);
                const cookieHeader = getHeaderValue(request.headers, "Cookie");

                // Keep the hash fragment: Firefox keeps it, and stripping it
                // desynchronizes the HAR URL from the tested URL.
                const url = parse(request.url + (request.urlFragment ?? ""), true);
                const postData = parsePostData(getHeaderValue(request.headers, "Content-Type"), request.postData);

                const entry: HarEntry = {
                    cache: {},
                    startedDateTime: "",
                    __requestWillBeSentTime: params.timestamp,
                    __wallTime: params.wallTime,
                    __key: key,
                    _requestId: params.requestId,
                    __frameId: params.frameId,
                    _initialPriority: request.initialPriority,
                    _priority: request.initialPriority,
                    pageref: page ? page.id : currentPageId,
                    request: {
                        method: request.method,
                        url: format(url),
                        queryString: toNameValuePairs(url.query),
                        postData,
                        headersSize: -1,
                        bodySize: request.postData ? request.postData.length : 0,
                        cookies: parseRequestCookies(cookieHeader),
                        headers: parseHeaders(request.headers),
                    },
                    time: 0,
                    _initiator_detail: SafeJSON.stringify(params.initiator, { strict: true }),
                    _initiator_type: params.initiator.type,
                    // Chrome's DevTools frontend lowercases this field.
                    _resourceType: params.type ? params.type.toLowerCase() : undefined,
                };

                if (request.isLinkPreload) {
                    entry.request._isLinkPreload = true;
                }

                // CDP render-blocking classification (Chrome 108+), lowercased
                // to match waterfall tooling expectations.
                if (params.renderBlockingBehavior) {
                    entry._renderBlocking = params.renderBlockingBehavior.toLowerCase();
                }

                switch (params.initiator.type) {
                    case "parser": {
                        entry._initiator = params.initiator.url;
                        entry._initiator_line = (params.initiator.lineNumber ?? 0) + 1;
                        break;
                    }

                    case "script": {
                        if (params.initiator.stack && params.initiator.stack.callFrames.length > 0) {
                            const topCallFrame = params.initiator.stack.callFrames[0];
                            entry._initiator = topCallFrame.url;
                            entry._initiator_line = topCallFrame.lineNumber + 1;
                            entry._initiator_column = topCallFrame.columnNumber + 1;
                            entry._initiator_function_name = topCallFrame.functionName;
                            entry._initiator_script_id = topCallFrame.scriptId;
                        }

                        break;
                    }

                    default:
                        break;
                }

                if (params.redirectResponse) {
                    populateRedirectResponse(page, key, params);
                }

                if (!page) {
                    log.debug({ requestId: params.requestId }, "request with no page yet; buffering");
                    entriesWithoutPage.push(entry);
                    paramsWithoutPage.push({ key, params });
                    continue;
                }

                entries.push(entry);
                addFromFirstRequest(page, params);
                // wallTime is not monotonic, timestamp is: derive startedDateTime from timestamp diffs.
                const entrySecs = (page.__wallTime ?? 0) + (params.timestamp - (page.__timestamp ?? 0));
                entry.startedDateTime = new Date(entrySecs * 1000).toISOString();
                break;
            }

            case "Network.requestServedFromCache": {
                const params = message.params as { requestId: string };
                const key = keyOf(message.sessionId, params.requestId);

                if (pages.length === 0 || ignoredRequests.has(key)) {
                    continue;
                }

                const entry = findEntry(key);
                if (!entry) {
                    log.debug({ requestId: params.requestId }, "requestServedFromCache with no matching request");
                    continue;
                }

                entry.__servedFromCache = true;
                entry.cache.beforeRequest = { lastAccess: "", eTag: "", hitCount: 0 };
                break;
            }

            case "Network.requestWillBeSentExtraInfo": {
                const params = message.params as {
                    requestId: string;
                    headers?: Record<string, string>;
                    associatedCookies?: CdpAssociatedCookie[];
                };
                const key = keyOf(message.sessionId, params.requestId);

                if (ignoredRequests.has(key)) {
                    continue;
                }

                const entry = findEntry(key) ?? entriesWithoutPage.find((e) => e.__key === key);
                if (!entry) {
                    log.debug({ requestId: params.requestId }, "extra info with no matching request");
                    continue;
                }

                if (params.headers) {
                    entry.request.headers = entry.request.headers.concat(parseHeaders(params.headers));
                }

                if (params.associatedCookies) {
                    entry.request.cookies = (entry.request.cookies || []).concat(
                        params.associatedCookies
                            .filter(({ blockedReasons }) => blockedReasons.length === 0)
                            .map(({ cookie }) => formatCookie(cookie))
                    );
                }

                break;
            }

            case "Network.responseReceivedExtraInfo": {
                const params = message.params as unknown as CdpResponseReceivedExtraInfoParams;
                const key = keyOf(message.sessionId, params.requestId);

                if (pages.length === 0 || ignoredRequests.has(key)) {
                    continue;
                }

                const entry = findEntry(key) ?? entriesWithoutPage.find((e) => e.__key === key);
                if (!entry) {
                    responseReceivedExtraInfos.push({ key, params });
                    continue;
                }

                if (!entry.response) {
                    // Extra info arrived before the response
                    entry.extraResponseInfo = {
                        headers: parseHeaders(params.headers),
                        blockedCookies: params.blockedCookies,
                    };
                    responseReceivedExtraInfos.push({ key, params });
                    continue;
                }

                if (params.headers) {
                    entry.response.headers = parseHeaders(params.headers);
                }

                break;
            }

            case "Network.responseReceived": {
                const params = message.params as unknown as CdpResponseReceivedParams;
                const key = keyOf(message.sessionId, params.requestId);

                if (pages.length === 0) {
                    responsesWithoutPage.push({ key, params });
                    continue;
                }

                if (ignoredRequests.has(key)) {
                    continue;
                }

                const entry = findEntry(key) ?? entriesWithoutPage.find((e) => e.__key === key);
                if (!entry) {
                    log.debug({ requestId: params.requestId }, "response with no matching request");
                    continue;
                }

                const frameId = (params.frameId && rootFrameMappings.get(params.frameId)) || params.frameId;
                const page = pages.find((p) => p.__frameId === frameId) || pageForTiming(message.sessionId);
                if (!page) {
                    log.debug({ requestId: params.requestId }, "response that maps to no page");
                    continue;
                }

                entryFromResponse(entry, params.response, page, opts);

                const extraInfo = responseReceivedExtraInfos.find((buffered) => buffered.key === key);
                if (extraInfo?.params.headers && entry.response) {
                    entry.response.headers = parseHeaders(extraInfo.params.headers);
                }

                break;
            }

            case "Network.dataReceived": {
                const params = message.params as { requestId: string; timestamp: number; dataLength: number };
                const key = keyOf(message.sessionId, params.requestId);

                if (pages.length === 0 || ignoredRequests.has(key)) {
                    continue;
                }

                const entry = findEntry(key);
                if (!entry) {
                    log.debug({ requestId: params.requestId }, "data received with no matching request");
                    continue;
                }

                // An entry can lack a response (sitespeed.io#2645).
                if (entry.response) {
                    entry.response.content.size += params.dataLength;
                }

                const page = pages.find((p) => p.id === entry.pageref);
                if (page) {
                    const chunk = {
                        ts: formatMillis((params.timestamp - (page.__timestamp ?? 0)) * 1000),
                        bytes: params.dataLength,
                    };
                    if (entry._chunks) {
                        entry._chunks.push(chunk);
                    } else {
                        entry._chunks = [chunk];
                    }
                }

                break;
            }

            case "Network.loadingFinished": {
                const params = message.params as { requestId: string; timestamp: number; encodedDataLength?: number };
                const key = keyOf(message.sessionId, params.requestId);

                if (pages.length === 0) {
                    continue;
                }

                if (ignoredRequests.has(key)) {
                    ignoredRequests.delete(key);
                    continue;
                }

                const entry = findEntry(key);
                if (!entry) {
                    log.debug({ requestId: params.requestId }, "loading finished with no matching request");
                    continue;
                }

                finalizeEntry(entry, params);
                break;
            }

            case "Page.loadEventFired": {
                const params = message.params as { timestamp?: number };

                if (pages.length === 0) {
                    continue;
                }

                const page = pageForTiming(message.sessionId);
                if (page && params.timestamp && page.__timestamp) {
                    page.pageTimings.onLoad = formatMillis((params.timestamp - page.__timestamp) * 1000);
                }

                break;
            }

            case "Page.domContentEventFired": {
                const params = message.params as { timestamp?: number };

                if (pages.length === 0) {
                    continue;
                }

                const page = pageForTiming(message.sessionId);
                if (page && params.timestamp && page.__timestamp) {
                    page.pageTimings.onContentLoad = formatMillis((params.timestamp - page.__timestamp) * 1000);
                }

                break;
            }

            case "Page.frameAttached": {
                const params = message.params as { frameId: string; parentFrameId: string };
                const frameId = params.frameId;
                const parentId = params.parentFrameId;

                rootFrameMappings.set(frameId, parentId);

                let grandParentId = rootFrameMappings.get(parentId);
                while (grandParentId) {
                    rootFrameMappings.set(frameId, grandParentId);
                    grandParentId = rootFrameMappings.get(grandParentId);
                }

                break;
            }

            case "Network.loadingFailed": {
                const params = message.params as {
                    requestId: string;
                    timestamp: number;
                    errorText?: string;
                    canceled?: boolean;
                };
                const key = keyOf(message.sessionId, params.requestId);

                if (ignoredRequests.has(key)) {
                    ignoredRequests.delete(key);
                    continue;
                }

                const entry = findEntry(key);
                if (!entry) {
                    log.debug({ requestId: params.requestId }, "loading failed with no matching request");
                    continue;
                }

                if (params.errorText === "net::ERR_ABORTED") {
                    finalizeEntry(entry, params);
                    log.debug({ requestId: params.requestId }, "load canceled by Chrome or user action");
                    continue;
                }

                // A network-level failure (bad DNS etc.) has no HAR representation.
                log.debug({ url: entry.request.url, canceled: params.canceled }, "failed load dropped from HAR");
                entries = entries.filter((e) => e.__key !== key);
                break;
            }

            case "Network.resourceChangedPriority": {
                const params = message.params as { requestId: string; newPriority: string };
                const key = keyOf(message.sessionId, params.requestId);

                const entry = findEntry(key);
                if (!entry) {
                    log.debug({ requestId: params.requestId }, "resourceChangedPriority with no matching request");
                    continue;
                }

                entry._priority = params.newPriority;
                break;
            }

            default: {
                // WebSocket frames, EventSource messages and page lifecycle
                // noise land here; HAR 1.2 has no representation for them.
                break;
            }
        }
    }

    if (!opts.includeResourcesFromDiskCache) {
        entries = entries.filter((entry) => entry.cache.beforeRequest === undefined);
    }

    entries = entries
        .filter((entry) => {
            if (!entry.response) {
                log.debug({ url: entry.request.url }, "dropping incomplete request");
            }

            return entry.response;
        })
        .map((element) => deleteInternalProperties(element));
    pages = pages.map((element) => deleteInternalProperties(element));
    pages = pages.filter((page) => entries.some((entry) => entry.pageref === page.id));

    const pagerefMapping = pages.reduce<Record<string, string>>((result, page, index) => {
        result[page.id] = `page_${index + 1}`;
        return result;
    }, {});

    pages = pages.map((page) => {
        page.id = pagerefMapping[page.id];
        return page;
    });
    entries = entries.map((entry) => {
        entry.pageref = entry.pageref ? pagerefMapping[entry.pageref] : entry.pageref;
        return entry;
    });

    return {
        log: {
            version: "1.2",
            creator: {
                name: "genesis-chrome-devtools",
                version: PORT_OF_VERSION,
                comment: "TS port of https://github.com/sitespeedio/chrome-har",
            },
            pages,
            entries,
        },
    };
}
