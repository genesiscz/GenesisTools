/** Port of chrome-har lib/headers.js (v1.3.1, MIT). Behavior kept 1:1. */
import { format } from "node:util";
import type { CdpHeaders, CdpResponse, HarNameValue, HarRequest } from "./types.ts";

export function calculateRequestHeaderSize(harRequest: HarRequest): number {
    let buffer = format("%s %s %s\r\n", harRequest.method, harRequest.url, harRequest.httpVersion);
    const headerLines = harRequest.headers.map((header) => format("%s: %s\r\n", header.name, header.value));
    buffer = buffer.concat(headerLines.join(""));
    buffer = buffer.concat("\r\n");

    return buffer.length;
}

export function calculateResponseHeaderSize(perflogResponse: CdpResponse): number {
    let buffer = format("%s %d %s\r\n", perflogResponse.protocol, perflogResponse.status, perflogResponse.statusText);
    for (const key of Object.keys(perflogResponse.headers)) {
        buffer = buffer.concat(format("%s: %s\r\n", key, perflogResponse.headers[key]));
    }

    buffer = buffer.concat("\r\n");

    return buffer.length;
}

export function parseHeaders(headers: CdpHeaders | undefined): HarNameValue[] {
    if (!headers) {
        return [];
    }

    return Object.keys(headers).map((key) => ({ name: key, value: headers[key] }));
}

export function getHeaderValue(headers: CdpHeaders | undefined, header: string): string {
    if (!headers) {
        return "";
    }

    const lowerCaseHeader = header.toLowerCase();

    return (
        Object.keys(headers)
            .filter((key) => key.toLowerCase() === lowerCaseHeader)
            .map((key) => headers[key])
            .shift() || ""
    );
}
