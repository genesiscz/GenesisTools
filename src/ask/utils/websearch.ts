import logger from "@app/logger";
import type { SearchResult, WebSearchOptions } from "@ask/types";

export class WebSearchTool {
    private apiKey?: string;
    private baseURL = "https://api.search.brave.com/res/v1";

    constructor() {
        this.apiKey = process.env.BRAVE_API_KEY;
        if (!this.apiKey) {
            logger.warn("BRAVE_API_KEY not found. Web search functionality will be disabled.");
        }
    }

    isAvailable(): boolean {
        return !!this.apiKey;
    }

    async searchWeb(query: string, options: Partial<WebSearchOptions> = {}): Promise<SearchResult[]> {
        if (!this.apiKey) {
            throw new Error("Web search not available. Please set BRAVE_API_KEY environment variable.");
        }

        const searchOptions: WebSearchOptions = {
            query,
            numResults: options.numResults || 5,
            safeSearch: options.safeSearch || "moderate",
            country: options.country || "us",
            language: options.language || "en",
            ...options,
        };

        try {
            logger.info(`Searching web for: "${query}"`);

            const params = new URLSearchParams();
            params.set("q", searchOptions.query);
            params.set("count", (searchOptions.numResults || 5).toString());
            if (searchOptions.safeSearch) {
                params.set("safesearch", searchOptions.safeSearch);
            }
            if (searchOptions.country) {
                params.set("country", searchOptions.country);
            }
            if (searchOptions.language) {
                params.set("search_lang", searchOptions.language);
            }
            params.set("text_decorations", "false");
            params.set("result_filter", "web");
            params.set("freshness", "pd"); // No specific freshness filter

            const response = await fetch(`${this.baseURL}/web/search?${params}`, {
                headers: {
                    "X-Subscription-Token": this.apiKey,
                    Accept: "application/json",
                    "User-Agent": "GenesisTools-ASK/1.0",
                },
            });

            if (!response.ok) {
                throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            if (!data.web?.results) {
                logger.warn("No search results found");
                return [];
            }

            interface BraveSearchResult {
                title?: string;
                url?: string;
                description?: string;
                age?: string;
            }

            const results: SearchResult[] = data.web.results.map((result: BraveSearchResult) => ({
                title: result.title || "",
                url: result.url || "",
                snippet: result.description || "",
                publishedDate: result.age ? this.parseAge(result.age) : undefined,
            }));

            logger.info(`Found ${results.length} search results`);
            return results;
        } catch (error) {
            logger.error(`Web search failed: ${error}`);
            throw error;
        }
    }

    private parseAge(age: string): string {
        // Parse age format like "2 days ago", "1 week ago", etc.
        try {
            const now = new Date();
            const match = age.match(/(\d+)\s+(day|week|month|year)s?\s+ago/i);

            if (!match) {
                return age;
            }

            const value = parseInt(match[1], 10);
            const unit = match[2].toLowerCase();

            let date: Date;

            switch (unit) {
                case "day":
                    date = new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
                    break;
                case "week":
                    date = new Date(now.getTime() - value * 7 * 24 * 60 * 60 * 1000);
                    break;
                case "month":
                    date = new Date(now.getFullYear(), now.getMonth() - value, now.getDate());
                    break;
                case "year":
                    date = new Date(now.getFullYear() - value, now.getMonth(), now.getDate());
                    break;
                default:
                    return age;
            }

            return date.toISOString().split("T")[0];
        } catch (error) {
            logger.warn(`Failed to parse age "${age}": ${error}`);
            return age;
        }
    }

    formatSearchResults(results: SearchResult[]): string {
        if (results.length === 0) {
            return "No search results found.";
        }

        let formatted = `🔍 Web Search Results (${results.length} results):\n\n`;

        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            formatted += `${i + 1}. **${result.title}**\n`;
            formatted += `   ${result.url}\n`;
            formatted += `   ${result.snippet}\n`;

            if (result.publishedDate) {
                formatted += `   📅 ${result.publishedDate}\n`;
            }

            formatted += "\n";
        }

        return formatted;
    }

    createSearchTool() {
        if (!this.isAvailable()) {
            return null;
        }

        return {
            description: "Search the web for current information using Brave Search",
            parameters: {
                query: {
                    type: "string",
                    description: "The search query to look up",
                },
                numResults: {
                    type: "number",
                    description: "Number of results to return (default: 5, max: 10)",
                    optional: true,
                },
                safeSearch: {
                    type: "string",
                    description: "Safe search level: 'off', 'moderate', or 'strict'",
                    optional: true,
                },
            },
            execute: async (params: { query: string; numResults?: number; safeSearch?: string }) => {
                try {
                    const results = await this.searchWeb(params.query, {
                        numResults: params.numResults,
                        safeSearch: params.safeSearch as WebSearchOptions["safeSearch"],
                    });

                    return {
                        results,
                        formatted: this.formatSearchResults(results),
                        count: results.length,
                    };
                } catch (error) {
                    logger.error(`Search tool execution failed: ${error}`);
                    return {
                        results: [],
                        formatted: `Search failed: ${error}`,
                        count: 0,
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
            },
        };
    }

    async getSearchSuggestions(query: string): Promise<string[]> {
        if (!this.apiKey) {
            return [];
        }

        try {
            const params = new URLSearchParams({
                q: query,
                count: "5",
            });

            const response = await fetch(`${this.baseURL}/suggestions?${params}`, {
                headers: {
                    "X-Subscription-Token": this.apiKey,
                    Accept: "application/json",
                },
            });

            if (!response.ok) {
                logger.warn(`Search suggestions failed: ${response.status}`);
                return [];
            }

            const data = await response.json();
            return data.suggestions || [];
        } catch (error) {
            logger.warn(`Failed to get search suggestions: ${error}`);
            return [];
        }
    }

    async validateApiKey(): Promise<boolean> {
        if (!this.apiKey) {
            return false;
        }

        try {
            const response = await fetch(`${this.baseURL}/web/search?q=test&count=1`, {
                headers: {
                    "X-Subscription-Token": this.apiKey,
                    Accept: "application/json",
                },
            });

            return response.status !== 401 && response.status !== 403;
        } catch (error) {
            logger.error(`API key validation failed: ${error}`);
            return false;
        }
    }

    getApiInfo(): { available: boolean; keyPresent: boolean; validated?: boolean } {
        return {
            available: this.isAvailable(),
            keyPresent: !!process.env.BRAVE_API_KEY,
        };
    }
}

// Singleton instance
export const webSearchTool = new WebSearchTool();
