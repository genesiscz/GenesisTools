import logger from "@app/logger";
import type { OAuth2Tokens, OAuthApplication } from "@app/timely/types";
import type { Storage } from "@app/utils/storage";
import { ExitPromptError } from "@inquirer/core";
import { input, password } from "@inquirer/prompts";
import chalk from "chalk";

export interface RequestOptions {
    params?: Record<string, string | number | boolean>;
    headers?: Record<string, string>;
    skipAuth?: boolean;
}

export class TimelyApiClient {
    private baseUrl = "https://api.timelyapp.com/1.1";
    private storage: Storage;

    constructor(storage: Storage) {
        this.storage = storage;
    }

    // ============================================
    // Authentication
    // ============================================

    /**
     * Ensure OAuth credentials exist, prompting if they don't
     */
    private async ensureOAuthCredentials(): Promise<OAuthApplication> {
        let oauth = await this.storage.getConfigValue<OAuthApplication>("oauth");

        if (!oauth?.client_id || !oauth?.client_secret || !oauth?.redirect_uri) {
            logger.info(chalk.yellow("\nOAuth application credentials not found."));
            logger.info("Create an OAuth application at: https://app.timelyapp.com/settings/oauth_applications\n");

            try {
                const clientId = await input({ message: "Client ID (App ID):" });
                const clientSecret = await password({ message: "Client Secret:" });
                const redirectUri = await input({
                    message: "Callback URL (Redirect URI):",
                    default: "urn:ietf:wg:oauth:2.0:oob",
                });

                oauth = {
                    client_id: clientId,
                    client_secret: clientSecret,
                    redirect_uri: redirectUri || "urn:ietf:wg:oauth:2.0:oob",
                };

                await this.storage.setConfigValue("oauth", oauth);
                logger.info(chalk.green("✓ OAuth credentials saved to config.\n"));
            } catch (error) {
                if (error instanceof ExitPromptError) {
                    logger.info("\nOperation cancelled by user.");
                    process.exit(0);
                }
                throw error;
            }
        }

        return oauth;
    }

    /**
     * Check if user is authenticated (has valid tokens)
     */
    async isAuthenticated(): Promise<boolean> {
        const tokens = await this.storage.getConfigValue<OAuth2Tokens>("tokens");
        return !!tokens?.access_token;
    }

    /**
     * Get valid access token, refreshing if necessary
     */
    private async getAccessToken(): Promise<string> {
        const tokens = await this.storage.getConfigValue<OAuth2Tokens>("tokens");
        if (!tokens?.access_token) {
            throw new Error("Not authenticated. Run 'tools timely login' first.");
        }

        // Check if token is expired (with 5 minute buffer)
        if (tokens.created_at && tokens.expires_in) {
            const expiresAt = (tokens.created_at + tokens.expires_in) * 1000;
            const bufferMs = 5 * 60 * 1000; // 5 minutes

            if (Date.now() > expiresAt - bufferMs) {
                logger.debug("Access token expired, refreshing...");
                const newTokens = await this.refreshToken(tokens.refresh_token);
                return newTokens.access_token;
            }
        }

        return tokens.access_token;
    }

    /**
     * Refresh the access token using refresh_token
     */
    private async refreshToken(refreshToken: string): Promise<OAuth2Tokens> {
        const oauth = await this.ensureOAuthCredentials();

        const response = await fetch("https://api.timelyapp.com/1.1/oauth/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: oauth.client_id,
                client_secret: oauth.client_secret,
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Token refresh failed: ${error}`);
        }

        const tokens = (await response.json()) as OAuth2Tokens;

        // Update stored tokens
        await this.storage.setConfigValue("tokens", {
            ...tokens,
            created_at: Math.floor(Date.now() / 1000),
        });

        logger.debug("Access token refreshed successfully");
        return tokens;
    }

    /**
     * Exchange authorization code for tokens
     */
    async exchangeCode(code: string): Promise<OAuth2Tokens> {
        const oauth = await this.ensureOAuthCredentials();

        const response = await fetch("https://api.timelyapp.com/1.1/oauth/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                grant_type: "authorization_code",
                code,
                client_id: oauth.client_id,
                client_secret: oauth.client_secret,
                redirect_uri: oauth.redirect_uri,
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Token exchange failed: ${error}`);
        }

        const tokens = (await response.json()) as OAuth2Tokens;

        // Store tokens with timestamp
        await this.storage.setConfigValue("tokens", {
            ...tokens,
            created_at: Math.floor(Date.now() / 1000),
        });

        return tokens;
    }

    // ============================================
    // HTTP Methods
    // ============================================

    /**
     * Make an authenticated request
     */
    private async request<T>(
        method: "GET" | "POST" | "PUT" | "DELETE",
        path: string,
        body?: unknown,
        options: RequestOptions = {},
    ): Promise<T> {
        const url = new URL(path.startsWith("http") ? path : `${this.baseUrl}${path}`);

        // Add query parameters
        if (options.params) {
            for (const [key, value] of Object.entries(options.params)) {
                if (value !== undefined && value !== null) {
                    url.searchParams.set(key, String(value));
                }
            }
        }

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            ...options.headers,
        };

        // Add authorization header unless skipped
        if (!options.skipAuth) {
            const token = await this.getAccessToken();
            headers.Authorization = `Bearer ${token}`;
        }

        logger.debug(`${method} ${url.toString()}`);

        const response = await fetch(url.toString(), {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`API request failed (${response.status}): ${error}`);
        }

        // Handle empty responses
        const text = await response.text();
        if (!text) {
            return {} as T;
        }

        return JSON.parse(text) as T;
    }

    /**
     * GET request
     */
    async get<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
        return this.request<T>("GET", path, undefined, { params });
    }

    /**
     * POST request
     */
    async post<T>(path: string, body: unknown): Promise<T> {
        return this.request<T>("POST", path, body);
    }

    /**
     * PUT request
     */
    async put<T>(path: string, body: unknown): Promise<T> {
        return this.request<T>("PUT", path, body);
    }

    /**
     * DELETE request
     */
    async delete<T>(path: string): Promise<T> {
        return this.request<T>("DELETE", path);
    }
}
