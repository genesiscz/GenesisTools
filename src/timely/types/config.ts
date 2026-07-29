/**
 * OAuth2 tokens stored in config
 */
export interface OAuth2Tokens {
    access_token: string;
    token_type: string; // Usually "bearer"
    refresh_token: string;
    created_at: number; // Unix timestamp (seconds)
    expires_in?: number; // Seconds until expiration (usually 7200)
    scope?: string; // OAuth scope
}

import type { TimelyAccount, TimelyProject } from "./api";

/**
 * OAuth2 application credentials (from Timely developer settings)
 */
export interface OAuthApplication {
    client_id: string;
    client_secret: string;
    redirect_uri: string; // Usually "urn:ietf:wg:oauth:2.0:oob" for CLI
}

/**
 * Main config stored in ~/.genesis-tools/timely/config.json
 */
export interface TimelyConfig {
    oauth?: OAuthApplication; // OAuth app credentials
    tokens?: OAuth2Tokens; // Current access/refresh tokens
    selectedAccountId?: number; // Default account ID
    selectedProjectId?: number; // Default project ID (optional)
    accounts?: TimelyAccount[]; // Cached list of accounts
    projects?: TimelyProject[]; // Cached list of projects
    cookie?: string; // Legacy location of the browser session Cookie header; now its own 0600 file, read once to migrate
    cookieUpdatedAt?: number; // Unix seconds, when the cookie was last stored
    authenticatedAt?: number; // Unix seconds of the last authorization-code exchange (NOT bumped by refreshes)
    user?: {
        id: number;
        email: string;
        name: string;
    };
}
