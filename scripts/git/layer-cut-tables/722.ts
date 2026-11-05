import type { CutBranch, CutTable } from "./types";

const groups = [
    [
        "shared-agents",
        "Shared session readers, harness approvals, agent delivery and cmux",
        [],
        [
            "src/utils/agent-sessions/**",
            "src/utils/agents/**",
            "src/utils/ai/**",
            "src/utils/audit/**",
            "src/utils/bun/**",
            "src/utils/claude/**",
            "src/utils/cmux/**",
            "src/utils/env/**",
            "src/utils/genesis-tools/**",
            "src/utils/harness/**",
            "src/utils/macos/**",
            "src/utils/providers/**",
            "src/utils/watch/**",
            "src/utils/package.json",
            "src/cmux/**",
            "src/ai/**",
            "src/claude/**",
        ],
    ],
    [
        "phone-notifications",
        "Phone notification transport, decisions and monitor channels",
        [],
        [
            "src/utils/notifications/**",
            "src/question/**",
            "src/monitor/**",
            "src/shops/**",
            "src/notify/**",
            "src/domains/**",
            "src/alza/**",
        ],
    ],
    ["hub-services", "Hub capabilities and commands consumed by the dashboard gateway", [], ["src/hub/**"]],
    [
        "gateway-mobile-tools",
        "Dashboard contracts, live gateway and native mobile tooling",
        [],
        [
            "src/dev-dashboard/**",
            "src/mobile/**",
            "src/utils/mobile/**",
            "bun.lock",
            "tsconfig.json",
            "DevDashboard/mobile/metro.config.js",
        ],
    ],
    [
        "phone-features",
        "Phone feature queries, fixtures and live cache",
        [],
        ["DevDashboard/mobile/src/features/**", "DevDashboard/mobile/src/api/**", "DevDashboard/mobile/src/live/**"],
    ],
    // 33 paths: routes mount the preceding 72-path feature/live layer; merging them would make 105 paths.
    [
        "phone-app",
        "Phone routes, security, push and application configuration",
        [],
        [
            "DevDashboard/mobile/src/app/**",
            "DevDashboard/mobile/src/lib/**",
            "DevDashboard/mobile/src/push/**",
            "DevDashboard/mobile/src/theme/**",
            "DevDashboard/mobile/*",
        ],
    ],
    [
        "e2e",
        "Generic e2e runner and the phone end-to-end flows",
        [],
        ["src/e2e/**", "src/utils/e2e/**", "e2e/**", "DevDashboard/mobile/e2e/**", "scripts/tools-entrypoint.test.ts"],
    ],
] as const;

const branches: CutBranch[] = groups.map(([id, description, globs, sweep], index) => ({
    name: `feat/2026-11-05-722-${id}`,
    parent: index === 0 ? null : `feat/2026-11-05-722-${groups[index - 1][0]}`,
    subject: `feat(tools): ${description}`,
    scopes: [],
    globs,
    sweep,
}));

export default {
    branches,
    keepAtBase: {},
    defaults: {
        unified: "origin/feat/2026-11-05-dev-dashboard-mobile-app",
        unifiedBranch: "feat/2026-11-05-dev-dashboard-mobile-app",
        base: "origin/feat/2026-11-03-ai-usage-6-review-followups",
    },
    selection: "diff",
    refPrefix: "refs/heads/cut/722/",
} satisfies CutTable;
