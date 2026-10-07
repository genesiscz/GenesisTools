import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { createClient } from "../mcp/client";
import { type JenkinsAuth, resolveAuth } from "../mcp/credentials";
import { type JenkinsRef, parseJenkinsInput } from "../mcp/url";

function localDate(d: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One line per request: UTC time, method, status, latency, URL. The file name uses the local date. */
export const API_LOG = join(tmpdir(), `${localDate()}-jenkins.log`);

export class JenkinsHttpError extends Error {
    constructor(
        public readonly status: number,
        public readonly url: string
    ) {
        super(`HTTP ${status}: ${url}`);
        this.name = "JenkinsHttpError";
    }
}

/**
 * A job path, or a Jenkins URL read relative to `baseUrl`. A URL must be on the configured Jenkins
 * (scheme, host, port and context path), so credentials for one instance never act on a job of the
 * same name on another, and a context path such as `/jenkins` is not prefixed a second time.
 */
export function refOnInstance(baseUrl: string, input: string): JenkinsRef {
    const trimmed = input.trim();

    if (!/^https?:\/\//i.test(trimmed)) {
        return parseJenkinsInput(trimmed);
    }

    const base = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
    const url = new URL(trimmed);

    if (url.origin !== base.origin || !`${url.pathname}/`.startsWith(base.pathname)) {
        throw new Error(`${trimmed} is not on the configured Jenkins (${base.origin}${base.pathname})`);
    }

    url.pathname = `/${url.pathname.slice(base.pathname.length)}`;

    return parseJenkinsInput(url.toString());
}

export interface PostResult {
    status: number;
    /** The `Location` header: the queue item of a triggered build. */
    location?: string;
}

export interface JenkinsBackend {
    baseUrl: string;
    /** The shared axios client, for the `lib/mcp` helpers that take one. */
    client: AxiosInstance;
    fullUrl(path: string): string;
    /** GET JSON, or throw `JenkinsHttpError` on any status other than 2xx. */
    api<T>(path: string): Promise<T>;
    /** As `api`, but `null` on 404. */
    apiOrNull<T>(path: string): Promise<T | null>;
    apiTextOrNull(path: string): Promise<string | null>;
    /** POST without following redirects. Never throws on a 4xx status. */
    post(path: string, form?: URLSearchParams): Promise<PostResult>;
}

export interface RestBackendOptions {
    auth: JenkinsAuth;
    /** A prepared client, for tests. Default: `createClient(auth)` with TLS and retry. */
    client?: AxiosInstance;
    /** Audit log file; an empty string turns it off. */
    auditLog?: string;
}

export function createRestBackend(opts: RestBackendOptions): JenkinsBackend {
    const baseUrl = opts.auth.url.replace(/\/+$/, "");
    const client = opts.client ?? createClient(opts.auth);
    const auditLog = opts.auditLog ?? API_LOG;

    const base = new URL(`${baseUrl}/`);

    // The client sends the Jenkins user and token with every request, so an absolute URL (a queue
    // `Location` header, for one) must stay on the configured Jenkins: same scheme, host, port and path.
    const fullUrl = (path: string): string => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
            const target = new URL(path);

            if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
                throw new Error(
                    `Refusing to send Jenkins credentials to ${target.origin}${target.pathname}: it is not under ${baseUrl}`
                );
            }

            return path;
        }

        return `${baseUrl}/${path.replace(/^\/+/, "")}`;
    };

    function audit(method: string, outcome: string, startedAt: number, url: string): void {
        if (!auditLog) {
            return;
        }

        try {
            appendFileSync(
                auditLog,
                `${new Date().toISOString()}\t${method}\t${outcome}\t${Date.now() - startedAt}ms\t${url}\n`
            );
        } catch (error) {
            logger.debug({ error, auditLog }, "jenkins: could not append to the audit log");
        }
    }

    async function request<T>(config: AxiosRequestConfig & { url: string }): Promise<AxiosResponse<T>> {
        const method = (config.method ?? "GET").toUpperCase();
        const url = fullUrl(config.url);
        const startedAt = Date.now();

        try {
            const res = await client.request<T>({ ...config, url });
            audit(method, String(res.status), startedAt, url);

            return res;
        } catch (error) {
            const code = (error as { code?: string; message?: string } | null)?.code;
            audit(method, `ERR:${code ?? (error instanceof Error ? error.message : String(error))}`, startedAt, url);
            throw error;
        }
    }

    async function api<T>(path: string): Promise<T> {
        const res = await request<T>({ url: path });

        if (res.status < 200 || res.status >= 300) {
            throw new JenkinsHttpError(res.status, fullUrl(path));
        }

        return res.data;
    }

    async function apiOrNull<T>(path: string): Promise<T | null> {
        try {
            return await api<T>(path);
        } catch (error) {
            if (error instanceof JenkinsHttpError && error.status === 404) {
                return null;
            }

            throw error;
        }
    }

    async function apiTextOrNull(path: string): Promise<string | null> {
        const res = await request<string>({
            url: path,
            responseType: "text",
            transformResponse: [(data: unknown) => data],
        });

        if (res.status === 404) {
            return null;
        }

        if (res.status < 200 || res.status >= 300) {
            throw new JenkinsHttpError(res.status, fullUrl(path));
        }

        return String(res.data ?? "");
    }

    async function post(path: string, form?: URLSearchParams): Promise<PostResult> {
        const res = await request<unknown>({
            url: path,
            method: "POST",
            maxRedirects: 0,
            data: form && form.toString() !== "" ? form.toString() : undefined,
            headers: form ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
        });
        const location = res.headers.location;

        return { status: res.status, location: typeof location === "string" ? location : undefined };
    }

    return { baseUrl, client, fullUrl, api, apiOrNull, apiTextOrNull, post };
}

let defaultBackend: Promise<JenkinsBackend> | null = null;

/** The backend for CLI commands: the environment's JENKINS_* variables, else the stored login. */
export function getJenkinsBackend(): Promise<JenkinsBackend> {
    defaultBackend ??= resolveAuth().then((auth) => createRestBackend({ auth }));
    return defaultBackend;
}

export function setJenkinsBackend(backend: JenkinsBackend | null): void {
    defaultBackend = backend ? Promise.resolve(backend) : null;
}
