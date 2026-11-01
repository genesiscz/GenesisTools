/** Messages between ImpersonatedHttpClient (client.ts) and its curl worker (worker.ts). */

export interface WorkerInit {
    type: "init";
    library: string;
    caBundle: string;
    /** A libcurl-impersonate target such as `chrome152`. */
    target: string;
    proxyUrl?: string;
}

export interface WorkerRequest {
    type: "request";
    id: number;
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
    followRedirects: boolean;
}

export interface WorkerAbort {
    type: "abort";
    id: number;
}

export interface WorkerClose {
    type: "close";
}

export type ToWorker = WorkerInit | WorkerRequest | WorkerAbort | WorkerClose;

export interface WorkerReady {
    type: "ready";
    /** The curl multi handle's address, so the client can call `curl_multi_wakeup` after it posts a request. */
    multi: number;
}

export interface WorkerFailed {
    type: "failed";
    error: string;
}

export interface WorkerReply {
    type: "reply";
    id: number;
    status: number;
    url: string;
    headers: Record<string, string>;
    body: ArrayBuffer;
    error: string | null;
}

export interface WorkerClosed {
    type: "closed";
}

export type FromWorker = WorkerReady | WorkerFailed | WorkerReply | WorkerClosed;
