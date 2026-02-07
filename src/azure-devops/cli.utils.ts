/**
 * Azure DevOps CLI Tool - CLI Utilities
 *
 * This file contains CLI-related utilities like error messages and user prompts.
 */

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

const AUTH_GUIDE = `
🔐 Azure CLI Authentication Required

You need to log in to Azure CLI first. Run:

  az login --allow-no-subscriptions --use-device-code

This will:
1. Display a code and URL
2. Open the URL in your browser
3. Enter the code to authenticate

Prerequisites:
  1. Install Azure CLI: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli
  2. Install Azure DevOps extension: az extension add --name azure-devops

Documentation: https://learn.microsoft.com/en-us/azure/devops/cli/?view=azure-devops
`;

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
        message.includes("az devops login")
    );
}

/**
 * Print SSL/proxy certificate guide and exit
 */
export function exitWithSslGuide(error?: unknown): never {
    console.log(SSL_PROXY_GUIDE);

    if (error instanceof Error && error.stack && process.env.DEBUG) {
        console.error("\nStacktrace:\n");
        console.error(error.stack);
    }

    process.exit(1);
}

/**
 * Print authentication guide and exit
 */
export function exitWithAuthGuide(error?: unknown): never {
    console.log(AUTH_GUIDE);

    if (error instanceof Error && error.stack && process.env.DEBUG) {
        console.error("\nStacktrace:\n");
        console.error(error.stack);
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

    console.error(`ERROR: ${message}`);
    process.exit(1);
}
