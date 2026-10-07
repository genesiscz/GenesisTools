import { readdirSync, readFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import tls from "node:tls";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from "axios";
import { type JenkinsAuth, JenkinsAuthMissingError } from "./credentials";

export type { JenkinsAuth } from "./credentials";

/**
 * Environment-only auth, for callers that must stay synchronous. Reading the
 * secret store is async, so anything that can await should use `resolveAuth`
 * from ./credentials instead and get the stored token as well.
 */
export function readEnvAuth(): JenkinsAuth {
    const url = env.jenkins.getUrl();
    const user = env.jenkins.getUser();
    const token = env.jenkins.getToken();

    if (!url || !user || !token) {
        const missing = [!url && "JENKINS_URL", !user && "JENKINS_USER", !token && "JENKINS_TOKEN"]
            .filter(Boolean)
            .join(", ");
        throw new JenkinsAuthMissingError(`${missing} not set`);
    }

    return { url, user, token };
}

/**
 * Certificates trusted on top of the public store: every `*.pem` file in `dir`, in name order.
 * A server that sends its own certificate without the intermediate fails verification here, because
 * bun (unlike a browser or curl) does not fetch a missing intermediate. Drop the intermediate and root
 * PEM files beside this file and that server verifies with no environment setup.
 */
export function loadTrustedPems(dir: string = import.meta.dir): string[] {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pem"))
            .map((entry) => entry.name)
            .sort()
            .map((name) => readFileSync(join(dir, name), "utf8"));
    } catch {
        return [];
    }
}

/**
 * `JENKINS_TLS_ACCEPT_UNAUTHORIZED=1` skips certificate verification. A last resort for a Jenkins whose
 * chain cannot be verified; the `*.pem` files beside this file are the safe way to trust a private chain.
 */
export function tlsAcceptUnauthorized(value: string | undefined = env.jenkins.getTlsAcceptUnauthorized()): boolean {
    return /^(1|true|yes)$/i.test(value ?? "");
}

export const TLS_ACCEPT_FLAG = "--tls-accept-unauthorized";

/** Set by `applyTlsAcceptFlag` when the command line carried `--tls-accept-unauthorized`. */
export const tlsAcceptFlag = { given: false };

/** Verification is off when the flag was given or the environment asks for it. */
export function tlsAccepted(): boolean {
    return tlsAcceptFlag.given || tlsAcceptUnauthorized();
}

/** Strips `--tls-accept-unauthorized` from anywhere in argv and records it in `tlsAcceptFlag`. */
export function applyTlsAcceptFlag(argv: string[]): string[] {
    if (!argv.includes(TLS_ACCEPT_FLAG)) {
        return argv;
    }

    tlsAcceptFlag.given = true;

    return argv.filter((arg) => arg !== TLS_ACCEPT_FLAG);
}

const CERTIFICATE_ERROR = /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|LEAF_SIGNATURE|certificate/i;

/** A failed TLS verification of the Jenkins host: retrying cannot help, so callers stop on it. */
export class JenkinsCertificateError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "JenkinsCertificateError";
    }
}

export function isCertificateError(e: unknown): boolean {
    const err = e as { code?: unknown; message?: unknown } | null;

    return CERTIFICATE_ERROR.test(String(err?.code ?? "")) || CERTIFICATE_ERROR.test(String(err?.message ?? ""));
}

/** Names both ways out of a failed verification: trust the chain, or skip verification. */
export function certificateErrorMessage(baseUrl: string, cause: unknown): string {
    const reason = cause instanceof Error ? cause.message : String(cause);

    return [
        `TLS verification of ${baseUrl} failed: ${reason}`,
        `Trust the chain: put the server's intermediate and root PEM files in ${import.meta.dir}.`,
        `Or skip verification (last resort): ${TLS_ACCEPT_FLAG} or JENKINS_TLS_ACCEPT_UNAUTHORIZED=1`,
    ].join("\n");
}

function createHttpsAgent(): https.Agent | undefined {
    const accept = tlsAccepted();
    const extraCa = loadTrustedPems();

    if (!accept && extraCa.length === 0) {
        return undefined;
    }

    if (accept) {
        logger.warn("jenkins: TLS verification is off (--tls-accept-unauthorized); the server is not verified");
    }

    return new https.Agent({
        ...(extraCa.length > 0 ? { ca: [...tls.rootCertificates, ...extraCa] } : {}),
        rejectUnauthorized: !accept,
    });
}

const IDEMPOTENT_METHODS = new Set(["get", "head", "options"]);

interface RetryConfig extends InternalAxiosRequestConfig {
    _retry?: number;
}

export function createClient(auth: JenkinsAuth): AxiosInstance {
    const instance = axios.create({
        baseURL: auth.url,
        auth: { username: auth.user, password: auth.token },
        httpsAgent: createHttpsAgent(),
        timeout: 30_000,
        // Throw on 5xx so the retry interceptor (which fires on AxiosError) kicks in.
        // Let 4xx through so handlers can branch on res.status === 404 (e.g. for builds
        // pruned by Jenkins retention, missing node IDs, etc).
        validateStatus: (status) => status < 500,
    });

    instance.interceptors.response.use(undefined, async (error) => {
        const cfg = error.config as RetryConfig | undefined;

        if (!cfg) {
            throw error;
        }

        if (!error.response && !tlsAccepted() && isCertificateError(error)) {
            throw new JenkinsCertificateError(certificateErrorMessage(auth.url, error), { cause: error });
        }

        cfg._retry = (cfg._retry ?? 0) + 1;
        const status = error.response?.status as number | undefined;
        // Only a request that is safe to repeat is retried. A POST Jenkins accepted before its answer
        // was lost (a timeout, a proxy's 502) would otherwise trigger the same build again.
        const idempotent = IDEMPOTENT_METHODS.has((cfg.method ?? "get").toLowerCase());
        const retriable = idempotent && (status === undefined || (status >= 500 && status < 600));

        if (cfg._retry > 3 || !retriable) {
            throw error;
        }

        const delay = 250 * 2 ** (cfg._retry - 1);
        logger.debug(`Jenkins retry ${cfg._retry}/3 for ${cfg.url} after ${delay}ms (status=${status ?? "net"})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return instance.request(cfg);
    });

    return instance;
}
