/**
 * Where Jenkins credentials come from: the environment, then the single object
 * written into the secret store by `tools jenkins-mcp login`.
 *
 * That object holds the URL alongside the username and token, so a stored login
 * is self-contained. Nothing needs JENKINS_URL to be exported, and nothing is
 * written to the repo or to a config file. The URL is the one the user typed at
 * the login prompt, never one inferred from the environment at read time.
 */
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { clearVault, readVault, secretStoreAvailable, secretStoreName, writeVault } from "./credentialStore";

export interface JenkinsAuth {
    url: string;
    user: string;
    token: string;
}

/** The whole stored object. One secret, every host, no key/value spreading. */
export interface JenkinsVault {
    version: 1;
    /** Host used when the environment names none. */
    defaultHost: string;
    hosts: Record<string, JenkinsAuth>;
}

export type AuthSource = "env" | "store";

export interface ResolvedAuth extends JenkinsAuth {
    source: AuthSource;
}

export const SETUP_COMMAND = "tools jenkins-mcp login";

/**
 * Thrown instead of a bare "missing env var", so an MCP client shows a user the
 * one command that fixes it rather than a stack trace.
 */
export class JenkinsAuthMissingError extends Error {
    constructor(public readonly detail: string) {
        super(setupMessage(detail));
        this.name = "JenkinsAuthMissingError";
    }
}

export function setupMessage(detail: string): string {
    return [
        `Jenkins credentials are not set up (${detail}).`,
        "",
        "Run this in a terminal:",
        "",
        `    ${SETUP_COMMAND}`,
        "",
        "It asks for the Jenkins URL, opens <jenkins>/me/security/ so you can create an",
        "API token, checks the token, and saves the URL, username and token together as one",
        "entry in the GenesisTools vault. Nothing is written to the repo or to any config file.",
        "",
        "Scripted alternative: export JENKINS_URL, JENKINS_USER and JENKINS_TOKEN.",
    ].join("\n");
}

/** Key for a Jenkins base URL inside the vault: its host, so instances coexist. */
export function hostKey(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    }
}

/** The page that creates an API token, without needing to know the username. */
export function tokenPageUrl(url: string): string {
    return new URL("/me/security/", url).toString();
}

function trimmed(value: string | undefined): string {
    return (value ?? "").trim();
}

function isAuth(value: unknown): value is JenkinsAuth {
    const a = value as Partial<JenkinsAuth> | null;
    return Boolean(
        a &&
            typeof a.url === "string" &&
            typeof a.user === "string" &&
            typeof a.token === "string" &&
            a.url &&
            a.user &&
            a.token
    );
}

/**
 * Readers only. An unreadable vault is reported and treated as absent, which is
 * right for a reader and WRONG for a writer \(see `loadVault`\).
 */
async function loadVaultForRead(): Promise<JenkinsVault | null> {
    try {
        return await loadVault();
    } catch (error) {
        logger.warn({ error }, "jenkins: the stored login could not be read; treating it as absent for this read");
        return null;
    }
}

/**
 * A malformed or truncated vault reads as absent, never as half-valid \(that is
 * a content judgement\). A STORE failure throws instead, so a writer never
 * mistakes "could not read" for "nothing stored".
 */
export async function loadVault(): Promise<JenkinsVault | null> {
    const raw = await readVault();

    if (!raw) {
        return null;
    }

    try {
        const parsed = SafeJSON.parse(raw) as Partial<JenkinsVault>;
        const hosts = parsed.hosts;

        if (!hosts || typeof hosts !== "object") {
            return null;
        }

        const clean: Record<string, JenkinsAuth> = {};

        for (const [host, auth] of Object.entries(hosts)) {
            if (isAuth(auth)) {
                clean[host] = auth;
            }
        }

        const keys = Object.keys(clean);

        if (keys.length === 0) {
            return null;
        }

        const defaultHost =
            typeof parsed.defaultHost === "string" && clean[parsed.defaultHost]
                ? parsed.defaultHost
                : (keys[0] as string);

        return { version: 1, defaultHost, hosts: clean };
    } catch {
        return null;
    }
}

export async function readStoredAuth(url?: string): Promise<JenkinsAuth | null> {
    const vault = await loadVaultForRead();

    if (!vault) {
        return null;
    }

    return vault.hosts[url ? hostKey(url) : vault.defaultHost] ?? null;
}

/** Store one login. The newest login becomes the default host. */
export async function saveAuth(auth: JenkinsAuth): Promise<boolean> {
    const host = hostKey(auth.url);
    let existing: JenkinsVault | null;

    try {
        existing = await loadVault();
    } catch (error) {
        // Refuse rather than overwrite. The write below spreads `existing.hosts`,
        // so continuing with a failed read would drop every other host.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Refusing to save: the existing login could not be read (${detail}). Nothing was changed.`);
    }

    const vault: JenkinsVault = {
        version: 1,
        defaultHost: host,
        hosts: { ...existing?.hosts, [host]: auth },
    };

    return writeVault(SafeJSON.stringify(vault));
}

/** Drop one host, or the whole object when that was the last one. */
export async function forgetAuth(url?: string): Promise<string | null> {
    // Also a writer: a failed read here would rewrite the object without the
    // hosts it could not see.
    const vault = await loadVault();

    if (!vault) {
        return null;
    }

    const host = url ? hostKey(url) : vault.defaultHost;

    if (!vault.hosts[host]) {
        return null;
    }

    delete vault.hosts[host];
    const remaining = Object.keys(vault.hosts);

    if (remaining.length === 0) {
        await clearVault();
        return host;
    }

    const written = await writeVault(
        SafeJSON.stringify({
            version: 1,
            defaultHost: vault.hosts[vault.defaultHost] ? vault.defaultHost : (remaining[0] as string),
            hosts: vault.hosts,
        } satisfies JenkinsVault)
    );

    return written ? host : null;
}

/**
 * The environment wins, so a scripted run and CI stay predictable, then the
 * store.
 *
 * JENKINS_URL deliberately does NOT count as "credentials started". It is
 * config, not a secret, and it is routinely set on its own by a local `.env`.
 * Counting it made a machine with no token report "partly set", which points
 * the reader at the wrong problem. Only a half-set SECRET (one of user/token
 * without the other) is worth calling out, because that really is a typo in a
 * variable name.
 *
 * When JENKINS_URL names a host the vault does not hold, that is an error and
 * not a silent fall-back to another host: the caller asked for a specific
 * Jenkins, and answering with a different one would be worse than saying so.
 */
export async function resolveAuth(): Promise<ResolvedAuth> {
    // `env.jenkins.*`, never `process.env`: this repo routes every variable
    // through the typed accessor so tests can override with `env.testing`.
    const url = trimmed(env.jenkins.getUrl());
    const user = trimmed(env.jenkins.getUser());
    const token = trimmed(env.jenkins.getToken());

    if (url && user && token) {
        return { url, user, token, source: "env" };
    }

    const vault = await loadVaultForRead();
    const stored = vault ? (vault.hosts[url ? hostKey(url) : vault.defaultHost] ?? null) : null;

    if (stored) {
        return { ...stored, source: "store" };
    }

    if (user || token) {
        const missing = [!url && "JENKINS_URL", !user && "JENKINS_USER", !token && "JENKINS_TOKEN"]
            .filter(Boolean)
            .join(", ");

        throw new JenkinsAuthMissingError(`${missing} not set, and ${describeVault(vault, url)}`);
    }

    if (!(await secretStoreAvailable())) {
        throw new JenkinsAuthMissingError(
            `no JENKINS_USER or JENKINS_TOKEN, and no master key rung could open ${secretStoreName()}`
        );
    }

    throw new JenkinsAuthMissingError(`no JENKINS_USER or JENKINS_TOKEN, and ${describeVault(vault, url)}`);
}

/** Say which host was looked for and what is actually stored, never just "nothing". */
function describeVault(vault: JenkinsVault | null, envUrl: string): string {
    if (!vault) {
        return `nothing saved in ${secretStoreName()}`;
    }

    const known = Object.keys(vault.hosts).join(", ");

    if (envUrl) {
        return `no login saved for ${hostKey(envUrl)} (JENKINS_URL names it); the store holds: ${known}`;
    }

    return `the store holds ${known}, but none of them resolved`;
}
