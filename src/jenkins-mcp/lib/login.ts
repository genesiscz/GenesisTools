/**
 * `jenkins-mcp login` — get an API token into the secret store without the user
 * hunting for the page that issues one.
 *
 * Jenkins aliases the signed-in user to `/me/`, so `<jenkins>/me/security/` is
 * the token page for whoever the browser is logged in as. That is why the flow
 * can open the right page before it knows the username. The username is still
 * asked for, because an API token is only accepted as the password half of
 * basic auth: the same token with a wrong username answers 401, and a bare
 * `Authorization: Bearer <token>` authenticates as anonymous (verified against
 * a real Jenkins on 2026-09-16, which answers 200 with `"name":"anonymous"` —
 * a status code alone does not prove a login worked).
 */
import { spawn } from "node:child_process";
import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { createClient } from "./client";
import { secretStoreAvailable, secretStoreName } from "./credentialStore";
import { forgetAuth, type JenkinsAuth, readStoredAuth, resolveAuth, saveAuth, tokenPageUrl } from "./credentials";

export interface LoginOptions {
    url?: string;
    user?: string;
    token?: string;
    /** Skip launching a browser; the URL is always printed either way. */
    noOpen?: boolean;
}

export interface WhoAmI {
    id: string;
    fullName: string;
}

function normalizeBaseUrl(raw: string): string {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return withScheme.replace(/\/+$/, "");
}

function openInBrowser(url: string): void {
    const cmd =
        process.platform === "darwin"
            ? ["open", url]
            : process.platform === "win32"
              ? ["cmd", "/c", "start", "", url]
              : ["xdg-open", url];

    try {
        spawn(cmd[0] as string, cmd.slice(1), { stdio: "ignore", detached: true }).unref();
    } catch {
        // Printing the URL is the contract; opening it is a convenience.
    }
}

/**
 * Prove the credentials work AND that they are not anonymous. `/me/api/json`
 * resolves to the authenticated user, so an anonymous request cannot satisfy it.
 */
export async function verifyAuth(auth: JenkinsAuth): Promise<WhoAmI> {
    const client = createClient(auth);
    const res = await client.get("/me/api/json?tree=id,fullName");

    if (res.status === 401 || res.status === 403) {
        throw new Error(`Jenkins rejected that username and token (HTTP ${res.status}).`);
    }

    if (res.status !== 200) {
        throw new Error(`Unexpected reply from ${auth.url}/me/api/json (HTTP ${res.status}).`);
    }

    const id = typeof res.data?.id === "string" ? res.data.id : "";

    if (!id || id === "anonymous") {
        throw new Error("That token authenticated as anonymous, so Jenkins did not accept it.");
    }

    return { id, fullName: typeof res.data?.fullName === "string" ? res.data.fullName : id };
}

export async function runLogin(opts: LoginOptions): Promise<number> {
    const scripted = Boolean(opts.url && opts.user && opts.token);

    if (!scripted) {
        p.intro("Jenkins login");
    }

    const existing = await readStoredAuth(opts.url);
    // No default URL baked in. The upstream copy of this file carries a specific
    // company Jenkins here; this repo is public, and a wrong default is worse
    // than an empty prompt.
    const url = normalizeBaseUrl(
        opts.url ??
            (await p.text({
                message: "Jenkins URL",
                initialValue: existing?.url ?? env.jenkins.getUrl(),
                placeholder: "https://jenkins.example.com",
            }))
    );

    if (p.isCancel(url)) {
        p.cancel("Cancelled.");
        return 1;
    }

    const tokenPage = tokenPageUrl(url);

    if (!scripted) {
        p.note(
            [
                tokenPage,
                "",
                "On that page: Add new token, name it (genesis-tools), Generate, then copy the value.",
                "Jenkins shows the token once. /me/ is Jenkins' alias for whoever is signed in,",
                "so this link works without knowing your username.",
            ].join("\n"),
            "Create an API token here"
        );

        if (!opts.noOpen) {
            openInBrowser(tokenPage);
        }
    }

    const user =
        opts.user ??
        (await p.text({
            message: "Jenkins username (the corporate login, not your full name)",
            initialValue: existing?.user ?? env.jenkins.getUser(),
            validate: (value) => (value.trim() ? undefined : "Required — a token alone authenticates as anonymous."),
        }));

    if (p.isCancel(user)) {
        p.cancel("Cancelled.");
        return 1;
    }

    const token = opts.token ?? (await p.password({ message: "Paste the API token" }));

    if (p.isCancel(token)) {
        p.cancel("Cancelled.");
        return 1;
    }

    const auth: JenkinsAuth = { url, user: String(user).trim(), token: String(token).trim() };
    const spin = scripted ? null : p.spinner();
    spin?.start("Checking the token");

    let who: WhoAmI;

    try {
        who = await verifyAuth(auth);
    } catch (error) {
        spin?.stop("Token rejected");
        const message = error instanceof Error ? error.message : String(error);
        scripted ? out.error(message) : p.log.error(message);
        return 1;
    }

    spin?.stop(`Signed in as ${who.fullName} (${who.id})`);

    if (!(await secretStoreAvailable())) {
        const message = [
            `No master key rung could open ${secretStoreName()}, so the token was not saved.`,
            "Export these instead:",
            `    export JENKINS_URL="${auth.url}"`,
            `    export JENKINS_USER="${auth.user}"`,
            '    export JENKINS_TOKEN="<the token you just pasted>"',
        ].join("\n");
        scripted ? out.error(message) : p.log.warn(message);
        return 1;
    }

    if (!(await saveAuth(auth))) {
        const message = "The secret store refused the write. Nothing was saved.";
        scripted ? out.error(message) : p.log.error(message);
        return 1;
    }

    const done = `Saved ${auth.url} for ${auth.user} in ${secretStoreName()}. Remove it with: tools jenkins-mcp logout`;

    if (scripted) {
        out.info(done);
    } else {
        p.outro(done);
    }

    return 0;
}

export async function runLogout(url?: string): Promise<number> {
    const account = await forgetAuth(url);

    if (!account) {
        out.info("Nothing stored.");
        return 0;
    }

    out.info(`Removed the stored token for ${account}.`);
    return 0;
}

export async function runAuthStatus(): Promise<number> {
    try {
        const auth = await resolveAuth();
        const who = await verifyAuth(auth);
        out.info(
            [
                `URL:    ${auth.url}`,
                `User:   ${who.fullName} (${who.id})`,
                `Source: ${auth.source === "env" ? "environment variables" : secretStoreName()}`,
            ].join("\n")
        );
        return 0;
    } catch (error) {
        out.error(error instanceof Error ? error.message : String(error));
        return 1;
    }
}
