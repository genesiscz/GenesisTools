#!/usr/bin/env bun

import log from '../logger'; // Updated logger import

const USER_ID = ""; // Consider making this configurable
const API_URL = `https://www.cursor.com/api/usage?user=${USER_ID}`;

interface UsageData {
    numRequests: number;
    numRequestsTotal: number;
    numTokens: number;
    maxRequestUsage: number | null;
    maxTokenUsage: number | null;
}

// Interface for the full API response
interface ApiResponse {
    "gpt-4"?: UsageData;
    "gpt-3.5-turbo"?: UsageData;
    "gpt-4-32k"?: UsageData; // Will be filtered out by logic
    startOfMonth?: string; // Field for the start date of the usage period
    // Allow other string keys that might represent other models or metadata
    [key: string]: UsageData | string | undefined;
}

const CURSOR_COOKIE = process.env.CURSOR_COOKIE;

if (!CURSOR_COOKIE) {
    log.error("CURSOR_COOKIE is not set. Set it in your environment variables.");
    process.exit(1); 
}

const headers = {
    accept: "*/*",
    "accept-language": "cs-CZ,cs;q=0.8",
    "cache-control": "no-cache",
    pragma: "no-cache",
    priority: "u=1, i",
    "sec-ch-ua": '"Chromium";v="136", "Brave";v="136", "Not.A/Brand";v="99"',
    "sec-ch-ua-arch": '"arm"',
    "sec-ch-ua-bitness": '"64"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-ch-ua-platform-version": '"15.4.1"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-gpc": "1",
    cookie: CURSOR_COOKIE,
    Referer: "https://www.cursor.com/settings",
    "Referrer-Policy": "strict-origin-when-cross-origin",
};

async function fetchCursorUsage() {
    log.info(`Fetching usage data for user: ${USER_ID} from ${API_URL}`);

    try {
        const response = await fetch(API_URL, {
            method: "GET",
            headers: headers,
        });

        if (!response.ok) {
            log.error(`HTTP error! Status: ${response.status} - ${response.statusText}`);
            try {
                const errorBody = await response.text();
                log.error(`Error body: ${errorBody}`);
            } catch (textError) {
                log.error(`Could not parse error body: ${(textError as Error).message}`);
            }
            return;
        }

        const data: ApiResponse = await response.json();
        log.info("Successfully fetched usage data.");
        
        if (data.startOfMonth) {
            log.info(`Usage data since: ${data.startOfMonth}`);
        }

        prettyPrintUsage(data);
    } catch (error) {
        log.error("Failed to fetch cursor usage data:");
        if (error instanceof Error) {
            log.error(`Message: ${error.message}`);
            if (error.stack) {
                log.error(`Stack: ${error.stack}`);
            }
        } else {
            log.error(`Unknown error: ${String(error)}`);
        }
    }
}

function prettyPrintUsage(data: ApiResponse) {
    log.info("--- Cursor Usage Report ---");

    const modelNameMapping: { [key: string]: string } = {
      "gpt-4": "Premium requests",
      "gpt-3.5-turbo": "Free requests",
    };
    // Ensure keys in modelsToOmit are lowercase for case-insensitive comparison
    const modelsToOmit: string[] = ["gpt-4-32k"]; 

    let modelsProcessed = 0;

    for (const key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
            // Skip non-model keys or keys marked for omission
            if (key === "startOfMonth" || modelsToOmit.includes(key.toLowerCase())) {
                continue;
            }

            const usageOrOther = data[key];

            // Type guard to ensure usageOrOther is UsageData
            if (usageOrOther && typeof usageOrOther === 'object' && 'numRequests' in usageOrOther) {
                const usage = usageOrOther as UsageData; // Cast after check
                
                const displayName = modelNameMapping[key.toLowerCase()] || key.toUpperCase();
                
                log.info(``); // Blank line for spacing
                log.info(`Model: ${displayName}`);
                log.info(`  Requests: ${usage.numRequests} (Total: ${usage.numRequestsTotal})`);
                log.info(`  Tokens: ${usage.numTokens.toLocaleString()}`);
                
                if (usage.maxRequestUsage !== null) {
                    log.info(`  Max Daily Requests: ${usage.maxRequestUsage}`);
                } else {
                    log.info(`  Max Daily Requests: Not specified`);
                }
                if (usage.maxTokenUsage !== null) {
                    log.info(`  Max Daily Tokens: ${usage.maxTokenUsage.toLocaleString()}`);
                } else {
                    log.info(`  Max Daily Tokens: Not specified`);
                }
                modelsProcessed++;
            } else if (usageOrOther !== undefined) {
                // Log if a key (that's not startOfMonth and not omitted) doesn't look like UsageData
                log.debug(`Skipping unexpected data structure for key: ${key}, value: ${JSON.stringify(usageOrOther)}`);
            }
        }
    }
    
    if (modelsProcessed === 0) {
        log.info("No relevant model usage data found after filtering.");
    }

    log.info(``); // Blank line for spacing
    log.info("--- End of Report ---");
}

fetchCursorUsage();
