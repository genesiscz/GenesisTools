import type { WatcherPreset } from "./types";

/**
 * One-click watchers. Every statuspage entry answers `/api/v2/status.json`
 * (verified 2026-09-03 with curl); status.x.ai sits behind a bot wall and is
 * left out on purpose.
 */
export const WATCHER_PRESETS: readonly WatcherPreset[] = [
    {
        id: "claude-status",
        name: "Claude status",
        kind: "statuspage",
        target: "https://status.claude.com",
        description: "claude.ai, Claude API and Console, as reported by status.claude.com.",
    },
    {
        id: "claude-api",
        name: "Claude API",
        kind: "statuspage",
        target: "https://status.claude.com",
        description: "Only the API component of status.claude.com.",
        config: { components: ["Claude API"] },
    },
    {
        id: "openai-status",
        name: "OpenAI status",
        kind: "statuspage",
        target: "https://status.openai.com",
        description: "ChatGPT and the OpenAI API, as reported by status.openai.com.",
    },
    {
        id: "xai-status",
        name: "xAI / Grok status",
        kind: "statuspage",
        target: "https://status.x.ai",
        description: "Grok apps, Grok in X and the xAI API regions, read from the Services list on status.x.ai.",
    },
    {
        id: "grok-api",
        name: "xAI API",
        kind: "statuspage",
        target: "https://status.x.ai",
        description: "Only the API regions on status.x.ai.",
        config: { components: ["API ("] },
    },
    {
        id: "xai-incidents",
        name: "xAI incidents feed",
        kind: "rss",
        target: "https://status.x.ai/feed.xml",
        description: "Every incident status.x.ai publishes, delivered as it appears.",
        intervalSec: 300,
    },
    {
        id: "claude-incidents",
        name: "Claude incidents feed",
        kind: "rss",
        target: "https://status.claude.com/history.rss",
        description: "Incident history feed of status.claude.com.",
        intervalSec: 300,
    },
    {
        id: "github-status",
        name: "GitHub status",
        kind: "statuspage",
        target: "https://www.githubstatus.com",
        description: "Git operations, Actions, API and Pages.",
    },
    {
        id: "cloudflare-status",
        name: "Cloudflare status",
        kind: "statuspage",
        target: "https://www.cloudflarestatus.com",
        description: "Cloudflare network and products.",
        intervalSec: 300,
    },
    {
        id: "cursor-status",
        name: "Cursor status",
        kind: "statuspage",
        target: "https://status.cursor.com",
        description: "Cursor editor and its AI backends.",
    },
    {
        id: "anthropic-api-http",
        name: "api.anthropic.com",
        kind: "website",
        target: "https://api.anthropic.com/v1/models",
        description: "Plain HTTP reachability of the Claude API host. Answers 401 without a key, which counts as up.",
        config: { expectStatus: 401, degradedAboveMs: 2_000 },
    },
    {
        id: "openai-api-http",
        name: "api.openai.com",
        kind: "website",
        target: "https://api.openai.com/v1/models",
        description: "Plain HTTP reachability of the OpenAI API host. Answers 401 without a key, which counts as up.",
        config: { expectStatus: 401, degradedAboveMs: 2_000 },
    },
];

export function findPreset(id: string): WatcherPreset | undefined {
    return WATCHER_PRESETS.find((preset) => preset.id === id);
}
