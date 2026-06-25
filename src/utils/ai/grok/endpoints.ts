import type { GrokEndpointDoc } from "./types";

export const GROK_UPSTREAM_ENDPOINTS: GrokEndpointDoc[] = [
    { method: "GET", path: "/v1/models", description: "Picker-visible model catalog" },
    { method: "GET", path: "/v1/settings", description: "Subscription tier and internal model defaults" },
    { method: "GET", path: "/v1/billing", description: "Subscription usage (cents)" },
    { method: "GET", path: "/v1/user", description: "Authenticated user profile" },
    { method: "POST", path: "/v1/responses", description: "Primary agent/chat API (Responses shape)" },
    { method: "POST", path: "/v1/chat/completions", description: "Chat Completions passthrough" },
];
