/**
 * Azure DevOps CLI Tool - CLI Utilities
 *
 * This file contains CLI-related utilities like error messages and user prompts.
 *
 * `az login` command suggestions live in `./lib/az-cli.utils.ts` — extract the
 * helpers from there instead of hand-rolling the command strings.
 */
import { azLoginSuggestionBlock, extractTenantFromStderr } from "@app/azure-devops/lib/az-cli.utils";
import { out } from "@app/logger";

const SSL_PROXY_GUIDE = `
🔐 SSL Certificate Error (Proxy Detected)

Azure CLI cannot verify SSL certificates - likely due to a corporate proxy
intercepting traffic with a self-signed certificate.

Quick fixes:

  1. Disable SSL verification (not recommended for production):
     export AZURE_CLI_DISABLE_CONNECTION_VERIFICATION=1

  2. Add your proxy's CA certificate to the trusted bundle:
     export REQUESTS_CA_BUNDLE=/path/to/your/ca-bundle.crt

  3. If using Charles/mitmproxy for debugging, export its certificate:
     - Charles: Help → SSL Proxying → Save Charles Root Certificate
     - Then: export REQUESTS_CA_BUNDLE=/path/to/charles-ssl-proxying.pem

More info: https://learn.microsoft.com/cli/azure/use-cli-effectively#work-behind-a-proxy
`;

function authGuide(): string {
    return `
🔐 Azure CLI Authentication Required

You need to log in to Azure CLI first. Run:

${azLoginSuggestionBlock()}

This will:
1. Display a code and URL (first form), or
2. Open a browser tab for interactive auth (second form)

Prerequisites:
  1. Install Azure CLI: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli
  2. Install Azure DevOps extension: az extension add --name azure-devops

Documentation: https://learn.microsoft.com/en-us/azure/devops/cli/?view=azure-devops
`;
}

/**
 * Check if an error message indicates an SSL/proxy certificate issue
 */
export function isSslError(message: string): boolean {
    return (
        message.includes("CERTIFICATE_VERIFY_FAILED") ||
        message.includes("SSLError") ||
        message.includes("SSLCertVerificationError") ||
        message.includes("self-signed certificate") ||
        message.includes("certificate verify failed")
    );
}

/**
 * Check if an error message indicates an authentication issue
 */
export function isAuthError(message: string): boolean {
    return (
        message.includes("login command") ||
        message.includes("setup credentials") ||
        message.includes("az login") ||
        message.includes("az devops login") ||
        message.includes("AADSTS50078") ||
        message.includes("AADSTS70043") ||
        message.includes("multi-factor authentication has expired") ||
        message.includes("Presented multi-factor")
    );
}

/**
 * Thrown by `Api.getAccessToken()` when `az account get-access-token` fails.
 * Carries the raw stderr and a parsed-out `az login ...` suggestion when present.
 */
export class AzAuthError extends Error {
    readonly stderr: string;
    readonly suggestedCommand: string | null;

    constructor(message: string, stderr: string, suggestedCommand: string | null) {
        super(message);
        this.name = "AzAuthError";
        this.stderr = stderr;
        this.suggestedCommand = suggestedCommand;
    }
}

/**
 * Build a working `az login` suggestion from auth-error stderr.
 *
 * Delegates to `azLoginSuggestionBlock` so the actual command strings live in
 * one place (`lib/az-cli.utils.ts`). Returns null if stderr doesn't look like
 * an auth error.
 */
export function extractAzLoginSuggestion(stderr: string): string | null {
    if (!stderr) {
        return null;
    }

    const tenant = extractTenantFromStderr(stderr);
    if (tenant) {
        // Trim the leading indent from the shared block so the suggestion
        // embeds cleanly in single-line error messages (callers already
        // prefix the field name, e.g. "Fix: ...").
        return azLoginSuggestionBlock({ tenant, indent: "" });
    }

    if (/AADSTS|az login|multi-factor|Presented multi-factor/i.test(stderr)) {
        return azLoginSuggestionBlock({ indent: "" });
    }

    return null;
}

/**
 * Print SSL/proxy certificate guide and exit
 */
export function exitWithSslGuide(error?: unknown): never {
    out.println(SSL_PROXY_GUIDE);

    if (error instanceof Error && error.stack && process.env.DEBUG) {
        out.error("\nStacktrace:\n");
        out.error(error.stack);
    }

    process.exit(1);
}

/**
 * Print authentication guide and exit
 */
export function exitWithAuthGuide(error?: unknown): never {
    out.println(authGuide());

    if (error instanceof Error && error.stack && process.env.DEBUG) {
        out.error("\nStacktrace:\n");
        out.error(error.stack);
    }

    process.exit(1);
}

/**
 * Handle error - shows auth guide if it's an auth error, otherwise logs the error
 */
export function handleCliError(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);

    if (isAuthError(message)) {
        exitWithAuthGuide();
    }

    out.error(`ERROR: ${message}`);
    process.exit(1);
}
