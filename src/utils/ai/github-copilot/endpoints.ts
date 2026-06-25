export const GITHUB_COPILOT_UPSTREAM_ENDPOINTS = [
    { method: "GET", path: "/models" },
    { method: "POST", path: "/chat/completions" },
    { method: "POST", path: "/responses" },
    { method: "POST", path: "/v1/messages" },
    { method: "GET", path: "/copilot_internal/user" },
] as const;
