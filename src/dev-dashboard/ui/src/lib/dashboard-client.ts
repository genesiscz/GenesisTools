import { createDashboardClient, DashboardHttpError } from "@app/dev-dashboard/contract/client";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * The web's one adapter onto the wire: the same origin and the browser's own `fetch`. Every dashboard
 * route the web reaches goes through this client, a dashboard route as a row of the endpoint table
 * (`dashboard.call(ENDPOINTS.<row>, input)`), a board route through `paths` and `dashboard.get`. The fetch is read at
 * call time, so a test can stand in for `globalThis.fetch`.
 */
export const dashboard = createDashboardClient({
    baseUrl: "",
    fetch: (url, init) => fetch(url, init),
});

/**
 * The same call, with a refusal turned into the sentence the server wrote: the `error` of a JSON body, else the body
 * text, else the status. The handoff panes and the folder dialog show that sentence as it is.
 */
export async function withServerMessage<T>(answer: Promise<T>): Promise<T> {
    try {
        return await answer;
    } catch (err) {
        if (!(err instanceof DashboardHttpError)) {
            throw err;
        }

        let message = err.body;

        try {
            const body: unknown = SafeJSON.parse(err.body, { strict: true });

            if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
                message = body.error;
            }
        } catch {
            // A body that is not JSON: its text is the message.
        }

        throw new Error(message || `${err.status}`);
    }
}
