import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { createRestBackend, JenkinsHttpError } from "./client";

const AUTH = { url: "https://jenkins.example.invalid/", user: "someone", token: "t0ken" };
const dir = mkdtempSync(join(tmpdir(), "jenkins-rest-"));

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

interface Seen {
    method: string;
    url: string;
    data?: unknown;
    maxRedirects?: number;
}

function backendWith(
    respond: (config: InternalAxiosRequestConfig) => Partial<AxiosResponse>,
    auditLog = ""
): { backend: ReturnType<typeof createRestBackend>; seen: Seen[] } {
    const seen: Seen[] = [];
    const client = axios.create({
        adapter: async (config) => {
            seen.push({
                method: (config.method ?? "get").toUpperCase(),
                url: String(config.url),
                data: config.data,
                maxRedirects: config.maxRedirects,
            });
            const partial = respond(config);
            const data =
                typeof partial.data === "string" && partial.data !== "" && config.responseType !== "text"
                    ? SafeJSON.parse(partial.data)
                    : partial.data;

            return { status: 200, statusText: "", headers: {}, config, request: {}, ...partial, data };
        },
    });

    return { backend: createRestBackend({ auth: AUTH, client, auditLog }), seen };
}

describe("createRestBackend", () => {
    it("joins paths onto the base URL and leaves absolute URLs alone", () => {
        const { backend } = backendWith(() => ({}));

        expect(backend.baseUrl).toBe("https://jenkins.example.invalid");
        expect(backend.fullUrl("job/app/1/api/json")).toBe("https://jenkins.example.invalid/job/app/1/api/json");
        expect(backend.fullUrl("/queue/api/json")).toBe("https://jenkins.example.invalid/queue/api/json");
        expect(backend.fullUrl("https://other.invalid/x")).toBe("https://other.invalid/x");
    });

    it("api returns the JSON body and throws JenkinsHttpError on a 4xx", async () => {
        const { backend } = backendWith((config) =>
            String(config.url).endsWith("/missing") ? { status: 403, data: "{}" } : { data: '{"mode":"NORMAL"}' }
        );

        expect(await backend.api<{ mode: string }>("api/json")).toEqual({ mode: "NORMAL" });
        await expect(backend.api("missing")).rejects.toBeInstanceOf(JenkinsHttpError);
    });

    it("apiOrNull and apiTextOrNull answer null on 404", async () => {
        const { backend } = backendWith((config) =>
            String(config.url).includes("gone") ? { status: 404, data: "" } : { data: "line 1\nline 2" }
        );

        expect(await backend.apiOrNull("job/gone/1/api/json")).toBeNull();
        expect(await backend.apiTextOrNull("job/gone/1/consoleText")).toBeNull();
        expect(await backend.apiTextOrNull("job/app/1/consoleText")).toBe("line 1\nline 2");
    });

    it("post sends the form, follows no redirect, and returns the Location header", async () => {
        const { backend, seen } = backendWith(() => ({
            status: 201,
            headers: { location: "https://jenkins.example.invalid/queue/item/7/" },
        }));
        const result = await backend.post("job/app/buildWithParameters", new URLSearchParams({ TAG: "v1" }));

        expect(result).toEqual({ status: 201, location: "https://jenkins.example.invalid/queue/item/7/" });
        expect(seen[0]).toMatchObject({ method: "POST", data: "TAG=v1", maxRedirects: 0 });
    });

    it("appends one audit line per request", async () => {
        const auditLog = join(dir, "audit.log");
        const { backend } = backendWith(() => ({ data: "{}" }), auditLog);

        await backend.api("api/json?tree=mode");
        const lines = readFileSync(auditLog, "utf8").trim().split("\n");

        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/\tGET\t200\t\d+ms\thttps:\/\/jenkins\.example\.invalid\/api\/json\?tree=mode$/);
    });
});
