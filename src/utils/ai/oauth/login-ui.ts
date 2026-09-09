import * as p from "@clack/prompts";
import { Browser } from "@genesiscz/utils/browser";
import { copyToClipboard } from "@genesiscz/utils/clipboard";
import { logger, out } from "@genesiscz/utils/logger";
import pc from "picocolors";

/** What the user asked us to do with the authorization URL. */
export type AuthorizationUrlAction = "open" | "copy" | "none";

export interface AuthorizationInteraction {
    chooseUrlAction(): Promise<"open" | "copy" | "none" | null>;
    readCode(options: { validate(value: string): string | undefined }): Promise<string | null>;
}

const terminalInteraction: AuthorizationInteraction = {
    async chooseUrlAction() {
        const action = await p.select({
            message: "How do you want to open it?",
            options: [
                { value: "open" as const, label: "Open in browser now" },
                { value: "copy" as const, label: "Copy the URL to my clipboard", hint: "overwrites whatever is in it" },
                { value: "none" as const, label: "Neither — I already have the code", hint: "clipboard untouched" },
            ],
        });
        return p.isCancel(action) ? null : action;
    },
    async readCode({ validate }) {
        const value = await p.text({
            message: "Paste the authorization code or callback URL:",
            placeholder: "code#state",
            validate: (value) => validate(value ?? ""),
        });
        return p.isCancel(value) ? null : value;
    },
};

async function openInDefaultBrowser(url: string): Promise<void> {
    const result = await Browser.open(url);

    if (!result.success) {
        logger.warn({ url, error: result.error }, "could not open the authorization URL in a browser");
        p.log.warn(`Could not open a browser (${result.error ?? "unknown error"}). Open the URL above by hand.`);
    }
}

export async function presentAuthorizationUrl(opts: {
    authUrl: string;
    provider: string;
    openUrl?: (url: string) => Promise<void>;
    copyUrl?: (url: string) => Promise<void>;
    interaction?: AuthorizationInteraction;
    /**
     * A loopback listener is serving the redirect URI, so the browser finishes on
     * its own and there is nothing to copy. Opt-in: a caller that omits it keeps
     * the copy-the-code wording, which is still the entire flow for a provider
     * whose redirect URI nobody local can serve.
     */
    callbackHandled?: boolean;
}): Promise<AuthorizationUrlAction> {
    p.note(
        [
            "1. Open the URL below in your browser",
            `2. Log in with your ${opts.provider} account`,
            "3. Authorize access",
            opts.callbackHandled
                ? "4. The browser comes back to this terminal on its own"
                : "4. Copy the code or full URL from the callback page",
        ].join("\n"),
        "OAuth Login"
    );
    out.println();
    out.println(`  ${pc.cyan(opts.authUrl)}`);
    out.println();
    const action = await (opts.interaction ?? terminalInteraction).chooseUrlAction();

    if (action === null) {
        throw new Error("Cancelled");
    }

    if (action === "open") {
        await (opts.openUrl ?? openInDefaultBrowser)(opts.authUrl);
    } else if (action === "copy") {
        await (opts.copyUrl ?? ((url) => copyToClipboard(url, { silent: true })))(opts.authUrl);
        p.log.info("URL copied. After authorizing, copy the CODE from the callback page — that is what to paste next.");
    }

    return action;
}

export function normalizeAuthorizationCode(input: string): { code: string } | { error: string } {
    const trimmed = input.trim();

    if (!trimmed.startsWith("http")) {
        return { code: trimmed };
    }

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch (error) {
        logger.debug({ error }, "[oauth] pasted value starts with http but is not a parseable URL");
        return { error: "That looks like a URL but could not be parsed. Paste the code shown after authorizing." };
    }

    if (url.pathname.includes("/oauth/authorize")) {
        return {
            error: "That is the authorization URL (what we copied to your clipboard), not the code. Open it, click Authorize, then paste the code from the callback page.",
        };
    }

    const code = url.searchParams.get("code");

    if (!code) {
        return { error: "No `code` parameter in that URL. Paste the code shown after authorizing." };
    }

    const state = url.searchParams.get("state");
    return { code: state ? `${code}#${state}` : code };
}

export async function readAuthorizationCode(
    interaction: AuthorizationInteraction = terminalInteraction
): Promise<{ code: string } | { error: string } | null> {
    const code = await interaction.readCode({
        validate(value) {
            if (!value.trim()) {
                return "Code is required";
            }

            const result = normalizeAuthorizationCode(value);
            return "error" in result ? result.error : undefined;
        },
    });

    if (code === null) {
        return null;
    }

    if (!code.trim()) {
        return { error: "Code is required" };
    }

    return normalizeAuthorizationCode(code);
}
