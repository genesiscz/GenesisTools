import { describe, expect, it } from "bun:test";
import axios from "axios";
import { cmdTriggers } from "../../commands/triggers";
import type { JenkinsBackend, PostResult } from "./client";
import {
    buildParamsForm,
    deriveQueueApiUrl,
    fetchBuildParameters,
    rebuild,
    resolveQueueToBuild,
    resolveRebuildTarget,
    triggerAccepted,
    triggerRebuild,
} from "./rebuild";

const BASE = "https://jenkins.example.invalid";

interface FakeRoutes {
    get?: (url: string) => unknown;
    post?: (url: string, form?: URLSearchParams) => PostResult;
}

function fakeBackend(routes: FakeRoutes): { backend: JenkinsBackend; calls: string[] } {
    const calls: string[] = [];
    const fullUrl = (path: string) => (path.startsWith("http") ? path : `${BASE}/${path.replace(/^\/+/, "")}`);
    const get = async <T>(path: string): Promise<T | null> => {
        const url = fullUrl(path);
        calls.push(`GET ${url}`);
        const body = routes.get?.(url);

        if (body instanceof Error) {
            throw body;
        }

        return (body ?? null) as T | null;
    };
    const backend: JenkinsBackend = {
        baseUrl: BASE,
        client: axios.create(),
        fullUrl,
        api: async <T>(path: string) => {
            const body = await get<T>(path);

            if (body === null) {
                throw new Error(`404 ${path}`);
            }

            return body;
        },
        apiOrNull: get,
        apiTextOrNull: get,
        post: async (path, form) => {
            const url = fullUrl(path);
            calls.push(`POST ${url}${form ? ` ${form}` : ""}`);

            return routes.post?.(url, form) ?? { status: 500 };
        },
    };

    return { backend, calls };
}

const PARAMS = {
    actions: [
        { _class: "hudson.model.CauseAction" },
        {
            _class: "hudson.model.ParametersAction",
            parameters: [
                { _class: "hudson.model.StringParameterValue", name: "TAG", value: "v1.2.3" },
                { _class: "hudson.model.BooleanParameterValue", name: "UPLOAD", value: false },
            ],
        },
    ],
};

describe("buildParamsForm", () => {
    it("serializes string, number and boolean params", () => {
        const form = buildParamsForm([
            { _class: "hudson.model.StringParameterValue", name: "TAG", value: "v1.2.3" },
            { _class: "hudson.model.BooleanParameterValue", name: "UPLOAD", value: false },
            { _class: "hudson.model.StringParameterValue", name: "COUNT", value: 5 },
        ]);

        expect(form.get("TAG")).toBe("v1.2.3");
        expect(form.get("UPLOAD")).toBe("false");
        expect(form.get("COUNT")).toBe("5");
    });

    it("skips null values and returns an empty form for no params", () => {
        const form = buildParamsForm([
            { _class: "x", name: "A", value: null },
            { _class: "x", name: "B", value: "keep" },
        ]);

        expect(form.has("A")).toBe(false);
        expect(form.get("B")).toBe("keep");
        expect([...buildParamsForm([]).keys()]).toEqual([]);
    });
});

describe("deriveQueueApiUrl", () => {
    it("appends api/json with or without a trailing slash", () => {
        expect(deriveQueueApiUrl(`${BASE}/queue/item/12345/`)).toBe(`${BASE}/queue/item/12345/api/json`);
        expect(deriveQueueApiUrl(`${BASE}/queue/item/12345`)).toBe(`${BASE}/queue/item/12345/api/json`);
    });
});

describe("resolveRebuildTarget", () => {
    it("takes the job path and number from a build URL", () => {
        expect(resolveRebuildTarget({ url: `${BASE}/job/Acme/job/web/964/console` })).toEqual({
            jobPath: "job/Acme/job/web",
            buildNumber: 964,
        });
    });

    it("refuses a URL without a build number", () => {
        expect(() => resolveRebuildTarget({ url: `${BASE}/job/web/` })).toThrow(/specific build/);
    });

    it("maps latest to lastBuild for a job path", () => {
        expect(resolveRebuildTarget({ jobPath: "job/web", buildNumber: "latest" })).toEqual({
            jobPath: "job/web",
            buildNumber: "lastBuild",
        });
    });
});

describe("fetchBuildParameters", () => {
    it("reads the parameters action and ignores the others", async () => {
        const { backend, calls } = fakeBackend({ get: () => PARAMS });
        const params = await fetchBuildParameters(backend, "job/web", 42);

        expect(params.map((p) => p.name)).toEqual(["TAG", "UPLOAD"]);
        expect(calls[0]).toBe(`GET ${BASE}/job/web/42/api/json?tree=actions[parameters[_class,name,value]]`);
    });

    it("returns no params for a build without a parameters action", async () => {
        const { backend } = fakeBackend({ get: () => ({ actions: [{ _class: "hudson.model.CauseAction" }] }) });

        expect(await fetchBuildParameters(backend, "job/web", "lastBuild")).toEqual([]);
    });
});

describe("triggerRebuild", () => {
    it("posts to buildWithParameters with the form when there are params", async () => {
        const { backend, calls } = fakeBackend({
            post: () => ({ status: 201, location: `${BASE}/queue/item/9/` }),
        });
        const result = await triggerRebuild(backend, "job/web", [{ _class: "x", name: "TAG", value: "v1" }]);

        expect(result.queueUrl).toBe(`${BASE}/queue/item/9/`);
        expect(calls).toEqual([`POST ${BASE}/job/web/buildWithParameters TAG=v1`]);
    });

    it("posts to build without a form when there are none", async () => {
        const { backend, calls } = fakeBackend({ post: () => ({ status: 201 }) });
        await triggerRebuild(backend, "job/web", []);

        expect(calls).toEqual([`POST ${BASE}/job/web/build`]);
    });

    it("throws on a 4xx answer", async () => {
        const { backend } = fakeBackend({ post: () => ({ status: 403 }) });

        await expect(triggerRebuild(backend, "job/web", [])).rejects.toThrow(/Trigger failed \(403\)/);
    });

    it("throws on a redirect to a login page instead of reporting a queued build", async () => {
        const { backend } = fakeBackend({ post: () => ({ status: 302, location: `${BASE}/login?from=%2Fjob%2Fweb` }) });

        await expect(triggerRebuild(backend, "job/web", [])).rejects.toThrow(/Trigger failed \(302 -> .*login/);
    });

    it("accepts 201, and a redirect only when it names a queue item", () => {
        expect(triggerAccepted({ status: 201 })).toBe(true);
        expect(triggerAccepted({ status: 302, location: `${BASE}/queue/item/9/` })).toBe(true);
        expect(triggerAccepted({ status: 302, location: `${BASE}/login` })).toBe(false);
        expect(triggerAccepted({ status: 302 })).toBe(false);
        expect(triggerAccepted({ status: 500, location: `${BASE}/queue/item/9/` })).toBe(false);
    });
});

describe("cmdTriggers", () => {
    const quick = { queueWaitMs: 20, pollMs: 5 };

    it("waits for each queue item to become a build before the next request", async () => {
        let item = 0;
        const { backend, calls } = fakeBackend({
            get: (url) => ({ executable: { number: 100 + Number(url.match(/item\/(\d+)/)?.[1]) } }),
            post: () => {
                item++;
                return { status: 201, location: `${BASE}/queue/item/${item}/` };
            },
        });

        await cmdTriggers("job/web", 2, { backend, ...quick });

        expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(2);
        expect(process.exitCode ?? 0).toBe(0);
    });

    it("sends no second request while the first item never becomes a build", async () => {
        const { backend, calls } = fakeBackend({
            get: () => ({ why: "Waiting for next available executor" }),
            post: () => ({ status: 201, location: `${BASE}/queue/item/1/` }),
        });

        try {
            await cmdTriggers("job/web", 3, { backend, ...quick });

            expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
            expect(process.exitCode).toBe(1);
        } finally {
            process.exitCode = 0;
        }
    });

    it("stops on a missing queue location and on a refused request", async () => {
        const noLocation = fakeBackend({ post: () => ({ status: 201 }) });
        const refused = fakeBackend({ post: () => ({ status: 302, location: `${BASE}/login` }) });

        try {
            await cmdTriggers("job/web", 2, { backend: noLocation.backend, ...quick });
            expect(noLocation.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);

            await cmdTriggers("job/web", 2, { backend: refused.backend, ...quick });
            expect(refused.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
            expect(process.exitCode).toBe(1);
        } finally {
            process.exitCode = 0;
        }
    });

    it("refuses a count below 1 before any request", async () => {
        const { backend, calls } = fakeBackend({});

        await expect(cmdTriggers("job/web", 0, { backend, ...quick })).rejects.toThrow("count of 1 or more");
        expect(calls).toEqual([]);
    });
});

describe("resolveQueueToBuild", () => {
    it("polls the queue item until it has an executable", async () => {
        let polls = 0;
        const { backend } = fakeBackend({
            get: () => {
                polls++;
                return polls < 3 ? { why: "Waiting" } : { executable: { number: 965 } };
            },
        });

        expect(await resolveQueueToBuild(backend, `${BASE}/queue/item/1/`, { pollMs: 1 })).toBe(965);
        expect(polls).toBe(3);
    });

    it("gives up after the timeout", async () => {
        const { backend } = fakeBackend({ get: () => ({}) });

        expect(
            await resolveQueueToBuild(backend, `${BASE}/queue/item/1/`, { timeoutMs: 20, pollMs: 5 })
        ).toBeUndefined();
    });
});

describe("rebuild", () => {
    it("fetches params, triggers, and resolves the new build number from a URL", async () => {
        const { backend } = fakeBackend({
            get: (url) => (url.includes("/queue/item/500/") ? { executable: { number: 965 } } : PARAMS),
            post: () => ({ status: 201, location: `${BASE}/queue/item/500/` }),
        });
        const result = await rebuild(backend, { url: `${BASE}/job/Acme/job/web/964/` }, { queueTimeoutMs: 1000 });

        expect(result).toMatchObject({
            triggered: true,
            sourceBuildNumber: 964,
            jobPath: "job/Acme/job/web",
            queueUrl: `${BASE}/queue/item/500/`,
            newBuildNumber: 965,
            newBuildUrl: `${BASE}/job/Acme/job/web/965/`,
        });
        expect(result.parameters).toHaveLength(2);
    });

    it("dry-run reads the params and never posts", async () => {
        const { backend, calls } = fakeBackend({ get: () => ({ actions: [] }) });
        const result = await rebuild(backend, { jobPath: "job/web", buildNumber: "latest" }, { dryRun: true });

        expect(result.triggered).toBe(false);
        expect(calls.every((c) => c.startsWith("GET "))).toBe(true);
    });

    it("wait=false skips the queue polling", async () => {
        const { backend, calls } = fakeBackend({
            get: () => ({ actions: [] }),
            post: () => ({ status: 201, location: `${BASE}/queue/item/1/` }),
        });
        const result = await rebuild(backend, { jobPath: "job/web", buildNumber: 1 }, { wait: false });

        expect(result.newBuildNumber).toBeUndefined();
        expect(result.queueUrl).toBe(`${BASE}/queue/item/1/`);
        expect(calls.some((c) => c.includes("/queue/"))).toBe(false);
    });
});
