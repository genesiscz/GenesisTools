/**
 * Types for the chrome-har TS port (upstream sitespeedio/chrome-har v1.3.1, MIT).
 *
 * The `__`-prefixed fields are internal bookkeeping deleted before output;
 * single-`_` fields are custom HAR extensions kept in the output, mirroring
 * upstream's convention (and Chrome DevTools' own `_initiator` etc.).
 */

export interface HarNameValue {
    name: string;
    value: string;
}

export interface HarCookie {
    name: string;
    value: string;
    path?: string;
    domain?: string;
    expires?: string;
    httpOnly?: boolean;
    secure?: boolean;
}

export interface HarPostData {
    mimeType: string;
    params?: HarNameValue[];
    text?: string;
}

export interface HarRequest {
    method: string;
    url: string;
    httpVersion?: string;
    queryString: HarNameValue[];
    postData?: HarPostData;
    headersSize: number;
    bodySize: number;
    cookies: HarCookie[];
    headers: HarNameValue[];
    _isLinkPreload?: boolean;
}

export interface HarContent {
    encoding?: string;
    mimeType?: string;
    charset?: string;
    size: number;
    text?: string;
    compression?: number;
}

export interface HarResponse {
    httpVersion: string;
    redirectURL: string;
    status: number;
    statusText: string;
    content: HarContent;
    headersSize: number;
    bodySize: number;
    cookies: HarCookie[];
    headers: HarNameValue[];
    _transferSize?: number;
    fromDiskCache: boolean;
    fromEarlyHints: boolean;
    fromServiceWorker: boolean;
    fromPrefetchCache: boolean;
}

export interface HarTimings {
    blocked: number;
    dns: number;
    connect: number;
    send: number;
    wait: number;
    receive: number;
    ssl: number;
    comment?: string;
    _queued?: number;
}

export interface HarPageTimings {
    onLoad?: number;
    onContentLoad?: number;
}

export interface HarPage {
    id: string;
    startedDateTime: string;
    title: string;
    pageTimings: HarPageTimings;
    _softNavigation?: boolean;
    __frameId?: string;
    __wallTime?: number;
    __timestamp?: number;
}

export interface HarCacheState {
    lastAccess: string;
    eTag: string;
    hitCount: number;
}

export interface HarEntry {
    cache: { beforeRequest?: HarCacheState };
    startedDateTime: string;
    time: number;
    pageref?: string;
    request: HarRequest;
    response?: HarResponse;
    timings?: HarTimings;
    connection?: string;
    serverIPAddress?: string;
    _requestId: string;
    _initialPriority?: string;
    _priority?: string;
    _initiator?: string;
    _initiator_line?: number;
    _initiator_column?: number;
    _initiator_function_name?: string;
    _initiator_script_id?: string;
    _initiator_detail?: string;
    _initiator_type?: string;
    _resourceType?: string;
    _renderBlocking?: string;
    _requestTime?: number;
    _was_pushed?: number;
    _chunks?: { ts: number; bytes: number }[];
    extraResponseInfo?: { headers: HarNameValue[]; blockedCookies?: CdpBlockedCookie[] };
    /** Session-scoped match key — the GenesisTools extension over upstream (multi-tab safety). */
    __key: string;
    __frameId?: string;
    __requestWillBeSentTime?: number;
    __wallTime?: number;
    __receiveHeadersEnd?: number;
    __servedFromCache?: boolean;
}

export interface HarFile {
    log: {
        version: "1.2";
        creator: { name: string; version: string; comment: string };
        pages: HarPage[];
        entries: HarEntry[];
    };
}

/** One recorded CDP event. `sessionId` scopes requestIds when several targets share one stream. */
export interface CdpMessage {
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
}

export type CdpHeaders = Record<string, string>;

export interface CdpResourceTiming {
    requestTime: number;
    dnsStart: number;
    dnsEnd: number;
    connectStart: number;
    connectEnd: number;
    sslStart: number;
    sslEnd: number;
    sendStart: number;
    sendEnd: number;
    receiveHeadersEnd: number;
    pushStart?: number;
}

export interface CdpResponse {
    url?: string;
    protocol: string;
    status: number;
    statusText: string;
    mimeType?: string;
    charset?: string;
    encoding?: string;
    headers: CdpHeaders;
    headersText?: string;
    requestHeaders?: CdpHeaders;
    requestHeadersText?: string;
    encodedDataLength: number;
    fromDiskCache?: boolean;
    fromEarlyHints?: boolean;
    fromServiceWorker?: boolean;
    fromPrefetchCache?: boolean;
    connectionId: number | string;
    remoteIPAddress?: string;
    timing?: CdpResourceTiming;
    /** Not CDP: set by the caller from Network.getResponseBody before building. */
    body?: string;
}

export interface CdpInitiator {
    type: string;
    url?: string;
    lineNumber?: number;
    stack?: {
        callFrames: { url: string; lineNumber: number; columnNumber: number; functionName: string; scriptId: string }[];
    };
}

export interface CdpRequestWillBeSentParams {
    requestId: string;
    frameId?: string;
    timestamp: number;
    wallTime: number;
    type?: string;
    renderBlockingBehavior?: string;
    initiator: CdpInitiator;
    redirectResponse?: CdpResponse;
    request: {
        method: string;
        url: string;
        urlFragment?: string;
        headers: CdpHeaders;
        postData?: string;
        isLinkPreload?: boolean;
        initialPriority?: string;
    };
}

export interface CdpBlockedCookie {
    cookie?: { name: string };
    cookieLine?: string;
    blockedReasons?: string[];
}

export interface CdpAssociatedCookie {
    cookie: {
        name?: string;
        key?: string;
        value: string;
        path?: string;
        domain?: string;
        expires?: number | string | Date | null;
        httpOnly?: boolean;
        secure?: boolean;
    };
    blockedReasons: string[];
}

export interface CdpResponseReceivedParams {
    requestId: string;
    frameId?: string;
    timestamp: number;
    response: CdpResponse;
}

export interface CdpResponseReceivedExtraInfoParams {
    requestId: string;
    headers?: CdpHeaders;
    blockedCookies?: CdpBlockedCookie[];
}

export interface HarBuildOptions {
    includeResourcesFromDiskCache?: boolean;
    includeTextFromResponseBody?: boolean;
}
