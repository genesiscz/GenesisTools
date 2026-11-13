import { describe, expect, test } from "bun:test";
import { Api } from "@app/azure-devops/api";
import { AdoHttpError, AzAuthError } from "@app/azure-devops/cli.utils";
import { fetchSearchRows } from "@app/azure-devops/commands/history-search";
import {
    FAKE_ADO_TOKEN,
    type FakeAdoHandler,
    FakeTransport,
    redirectedResponse,
} from "@app/azure-devops/lib/fake-transport.fixtures";
import type { AzureConfig } from "@app/azure-devops/types";

const ORG = "https://dev.azure.com/contoso-fixture";

const CONFIG: AzureConfig = {
    org: ORG,
    project: "Project Alpha",
    projectId: "00000000-0000-0000-0000-00000000a1fa",
    apiResource: "499b84ac-1321-427f-aa17-267ca6975798",
};

function apiAnswering(handler: FakeAdoHandler, timeoutMs?: number): { api: Api; transport: FakeTransport } {
    const transport = new FakeTransport([["GET /", handler]]);

    return { api: new Api(CONFIG, transport.apiOptions({ timeoutMs })), transport };
}

/** A 203 is the sign-in page only `send` recognizes: a caller that reaches `send` turns it into AzAuthError. */
const signInPage = () =>
    new Response("<html>sign in</html>", { status: 203, headers: { "Content-Type": "text/html" } });

describe("Api.send", () => {
    test("sends the token and turns a redirect to /_signout into AzAuthError", async () => {
        const { api, transport } = apiAnswering(() => redirectedResponse(`${ORG}/_signout?reason=expired`));

        await expect(api.getTags()).rejects.toBeInstanceOf(AzAuthError);
        await expect(api.getTags()).rejects.toThrow("redirected to /_signout");
        expect(new Headers(transport.calls[0].init?.headers).get("Authorization")).toBe(`Bearer ${FAKE_ADO_TOKEN}`);
    });

    test("turns the 203 sign-in page into AzAuthError", async () => {
        const { api } = apiAnswering(signInPage);

        await expect(api.getTags()).rejects.toBeInstanceOf(AzAuthError);
        await expect(api.getTags()).rejects.toThrow("HTTP 203");
    });

    test("refuses an HTML body that came back with status 200", async () => {
        const { api } = apiAnswering(
            () => new Response("<html><body>Proxy login</body></html>", { headers: { "Content-Type": "text/html" } })
        );

        await expect(api.getTags()).rejects.toThrow("returned HTML instead of JSON");
    });

    test("gives up after the timeout and names the request", async () => {
        const { api } = apiAnswering(
            ({ init }) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
                    // Without a signal the request would hang, and bun does not end a test whose promise never
                    // settles, so the run fails here instead.
                    setTimeout(() => reject(new Error("the request carried no timeout signal")), 1000);
                }),
            20
        );

        await expect(api.getTags()).rejects.toThrow("did not answer GET");
    });

    test("throws AdoHttpError with the status and url of a 404", async () => {
        const { api } = apiAnswering(() => new Response("TF401232: Work item 4242 does not exist.", { status: 404 }));

        const failure = await api.getWorkItemUpdates(4242).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AdoHttpError);
        expect((failure as AdoHttpError).status).toBe(404);
        expect((failure as AdoHttpError).url).toStartWith(`${ORG}/Project%20Alpha/_apis/wit/workItems/4242/updates`);
        expect((failure as AdoHttpError).message).toBe("API Error 404: TF401232: Work item 4242 does not exist.");
    });

    test("fetchBinary carries the status and url of a failed download", async () => {
        const { api } = apiAnswering(() => new Response("gone", { status: 410 }));
        const url = `${ORG}/Project%20Alpha/_apis/git/repositories/r-1/items?path=/a.png`;

        const failure = await api.fetchBinary(url).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AdoHttpError);
        expect((failure as AdoHttpError).status).toBe(410);
        expect((failure as AdoHttpError).url).toBe(url);
    });
});

describe("organization lookups go through send", () => {
    test("getProjectId reads the project by name, and a sign-in page fails it", async () => {
        const transport = new FakeTransport([["GET /_apis/projects/Project%20Alpha", () => ({ id: "p-alpha" })]]);

        expect(await Api.forOrganization(ORG, transport.apiOptions()).getProjectId("Project Alpha")).toBe("p-alpha");
        expect(transport.calls[0].init?.signal).toBeInstanceOf(AbortSignal);
        await expect(
            Api.forOrganization(ORG, new FakeTransport([["GET /", signInPage]]).apiOptions()).getProjectId("x")
        ).rejects.toBeInstanceOf(AzAuthError);
    });

    test("getProjects lists the projects sorted by name, and a sign-in page fails it", async () => {
        const transport = new FakeTransport([
            [
                "GET /_apis/projects?",
                () => ({
                    value: [
                        { id: "p-beta", name: "Project Beta", state: "wellFormed" },
                        { id: "p-alpha", name: "Project Alpha", state: "wellFormed" },
                    ],
                }),
            ],
        ]);

        expect(await Api.forOrganization(ORG, transport.apiOptions()).getProjects()).toEqual([
            { id: "p-alpha", name: "Project Alpha" },
            { id: "p-beta", name: "Project Beta" },
        ]);
        await expect(
            Api.forOrganization(ORG, new FakeTransport([["GET /", signInPage]]).apiOptions()).getProjects()
        ).rejects.toBeInstanceOf(AzAuthError);
    });

    test("getOrgId reads connectionData at api-version 5.0-preview, and a sign-in page fails it", async () => {
        const transport = new FakeTransport([["GET /_apis/connectionData", () => ({ instanceId: "org-guid-1" })]]);

        expect(await Api.forOrganization(ORG, transport.apiOptions()).getOrgId()).toBe("org-guid-1");
        expect(new URL(transport.calls[0].url).searchParams.get("api-version")).toBe("5.0-preview");
        await expect(
            Api.forOrganization(ORG, new FakeTransport([["GET /", signInPage]]).apiOptions()).getOrgId()
        ).rejects.toBeInstanceOf(AzAuthError);
    });
});

describe("history-search reads its rows through send", () => {
    test("keeps rev and the project of each row, and a sign-in page fails it", async () => {
        const transport = new FakeTransport([
            [
                "GET /_apis/wit/workitems?",
                () => ({
                    value: [
                        {
                            id: 7,
                            rev: 3,
                            fields: {
                                "System.Title": "Fix the login form",
                                "System.State": "Active",
                                "System.WorkItemType": "Bug",
                                "System.TeamProject": "Project Beta",
                                "System.ChangedDate": "2026-01-02T10:00:00Z",
                                "System.AssignedTo": { displayName: "Alice Example" },
                            },
                        },
                    ],
                }),
            ],
        ]);

        const rows = await fetchSearchRows(new Api(CONFIG, transport.apiOptions()), CONFIG, [7]);

        expect(rows).toEqual([
            {
                id: 7,
                rev: 3,
                title: "Fix the login form",
                state: "Active",
                type: "Bug",
                project: "Project Beta",
                changed: "2026-01-02T10:00:00Z",
                assignee: "Alice Example",
                url: `${ORG}/Project%20Beta/_workitems/edit/7`,
            },
        ]);
        expect(new URL(transport.calls[0].url).searchParams.get("ids")).toBe("7");
        await expect(
            fetchSearchRows(new Api(CONFIG, new FakeTransport([["GET /", signInPage]]).apiOptions()), CONFIG, [7])
        ).rejects.toBeInstanceOf(AzAuthError);
    });
});
