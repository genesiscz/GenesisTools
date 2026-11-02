import { ApifyClient, ApifyError, type ApifyUser } from "@app/apify/lib/client";
import { toolCommand } from "@genesiscz/utils/cli";
import { secretSnapshot, secrets } from "@genesiscz/utils/security/SecretStore";

export const APIFY_SECRET_PATH = "apify/api-token";

export interface ApifyCredentials {
    has(): boolean;
    get(): Promise<string | undefined>;
    save(token: string): Promise<void>;
    remove(): Promise<boolean>;
}

export const vaultCredentials: ApifyCredentials = {
    has: () => secretSnapshot().has(APIFY_SECRET_PATH),
    get: () => secretSnapshot().get(APIFY_SECRET_PATH),
    save: async (token) => {
        await (await secrets()).set(APIFY_SECRET_PATH, token);
    },
    remove: async () => {
        if (!secretSnapshot().has(APIFY_SECRET_PATH)) {
            return false;
        }

        return (await secrets()).delete(APIFY_SECRET_PATH);
    },
};

export function validateToken(value: string): string {
    const token = value.trim();
    if (token.length < 10 || token.length > 4096 || !/^[!-~]+$/.test(token)) {
        throw new ApifyError("Provide a single Apify API token, without quotes or spaces.");
    }

    return token;
}

export async function login(options: {
    token: string;
    credentials?: ApifyCredentials;
    validate?: (token: string) => Promise<ApifyUser>;
}) {
    const token = validateToken(options.token);
    const user = await (options.validate ?? ((value) => new ApifyClient({ token: value }).me()))(token);
    await (options.credentials ?? vaultCredentials).save(token);
    return { authenticated: true, user };
}

export function status(credentials: ApifyCredentials = vaultCredentials) {
    return { stored: credentials.has(), storage: "encrypted-vault", next: toolCommand("apify status --check") };
}

export async function requireToken(credentials: ApifyCredentials = vaultCredentials): Promise<string> {
    const token = await credentials.get();
    if (!token) {
        throw new ApifyError(`No saved Apify token. Run ${toolCommand("apify login")}.`);
    }

    return token;
}

export async function logout(credentials: ApifyCredentials = vaultCredentials) {
    return { removed: await credentials.remove(), remotelyRevoked: false };
}
