/**
 * Test-only: a fake Azure DevOps that answers by route, for both seams of `Api`.
 *
 * - As an `AdoTransport`, it stands in for `Api.call` (the test-plans area client).
 * - As `ApiOptions.fetch`, it sits under `Api.send`, so a test of any `Api` method runs the real token header,
 *   sign-out, sign-in page, HTML, timeout and status checks, and no request leaves the machine.
 */

import type { AdoFetch, AdoRequest, AdoResponse, AdoTransport, ApiOptions } from "@app/azure-devops/api.types";
import { SafeJSON } from "@genesiscz/utils/json";

/** The bearer token every fake-backed `Api` sends. */
export const FAKE_ADO_TOKEN = "fixture-token";

/** One recorded request. `init` is set for a request that came through `fetch` (under `Api.send`). */
export interface FakeAdoCall extends AdoRequest {
    init?: RequestInit;
}

/**
 * Answers one request. Through `fetch`, a `Response` goes out as it is, an `ArrayBuffer` as a binary body, and
 * anything else as a JSON body with status 200. Through `call`, the value is the parsed body.
 */
export type FakeAdoHandler = (request: FakeAdoCall) => unknown;

/** Answers by `METHOD path-fragment`, first match wins; an unmatched request fails the test. Every request is recorded. */
export class FakeTransport implements AdoTransport {
    readonly calls: FakeAdoCall[] = [];

    constructor(private readonly routes: [string, FakeAdoHandler][]) {}

    async call<T>(request: AdoRequest): Promise<AdoResponse<T>> {
        this.calls.push(request);

        return { data: (await this.route(request)(request)) as T };
    }

    readonly fetch: AdoFetch = async (url, init) => {
        const body = typeof init.body === "string" ? SafeJSON.parse(init.body) : undefined;
        const headers = new Headers(init.headers);
        const request: FakeAdoCall = {
            method: (init.method ?? "GET") as FakeAdoCall["method"],
            url,
            body,
            contentType: headers.get("Content-Type") ?? undefined,
            description: "",
            init,
        };
        this.calls.push(request);
        const answer = await this.route(request)(request);

        if (answer instanceof Response) {
            return answer;
        }

        if (answer instanceof ArrayBuffer) {
            return new Response(answer, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
        }

        return Response.json(answer);
    };

    /** `new Api(config, fake.apiOptions())`: this fake under `send`, and a fixed token instead of `az`. */
    apiOptions(extra: Omit<ApiOptions, "fetch" | "accessToken"> = {}): ApiOptions {
        return { fetch: this.fetch, accessToken: async () => FAKE_ADO_TOKEN, ...extra };
    }

    writes(): FakeAdoCall[] {
        return this.calls.filter((call) => call.method !== "GET" && !call.url.includes("/wiql"));
    }

    private route(request: AdoRequest): FakeAdoHandler {
        const url = new URL(request.url);
        const path = url.pathname + url.search;
        const route = this.routes.find(([key]) => {
            const [method, fragment] = key.split(" ");
            return method === request.method && path.includes(fragment);
        });

        if (!route) {
            throw new Error(`unexpected ${request.method} ${path}`);
        }

        return route[1];
    }
}

/** A `Response` whose `redirected` and `url` say it ended on `url`, as `fetch` reports a followed redirect. */
export function redirectedResponse(url: string, init: ResponseInit = {}): Response {
    const response = new Response("<html>signed out</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
        ...init,
    });

    return Object.defineProperties(response, { redirected: { value: true }, url: { value: url } });
}
