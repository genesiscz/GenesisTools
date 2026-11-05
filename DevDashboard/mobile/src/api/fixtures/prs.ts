import type { PrChecksDto, PrTriageDto } from "@dd/contract";

// Invented PRs for the mock agent and the tests: projects, authors, branches and URLs are made up.

export const MOCK_PR_TRIAGE: PrTriageDto = {
    generatedAt: "2026-10-01T12:00:00.000Z",
    prs: [
        {
            url: "https://github.com/example/shop/pull/12",
            provider: "github",
            number: 12,
            title: "Cart totals round per line, not per order",
            repo: "shop",
            checkout: "/work/shop",
            author: "alice",
            isMine: true,
            draft: false,
            headBranch: "feat/cart-rounding",
            ci: "success",
            verdict: "ready",
            summary: "ready: CI green, no unresolved threads",
            reasons: [],
            unresolved: 0,
            mergeable: "mergeable",
            readinessError: null,
            updatedAt: "2026-10-01T11:40:00.000Z",
        },
        {
            url: "https://github.com/example/shop/pull/9",
            provider: "github",
            number: 9,
            title: "Checkout keeps the address between steps",
            repo: "shop",
            checkout: "/work/shop-feat-address",
            author: "alice",
            isMine: true,
            draft: false,
            headBranch: "feat/address",
            ci: "failed",
            verdict: "blocked",
            summary: "blocked: CI failed",
            reasons: ["CI failed: test (ubuntu)", "2 unresolved threads"],
            unresolved: 2,
            mergeable: "mergeable",
            readinessError: null,
            updatedAt: "2026-10-01T10:10:00.000Z",
        },
    ],
    skipped: [],
};

export function mockPrChecks(url: string): PrChecksDto {
    const failing = url.endsWith("/9");
    return {
        url,
        checks: [{ name: "test (ubuntu)", status: failing ? "failed" : "success", url: `${url}/checks` }],
        failing: failing
            ? {
                  name: "test (ubuntu) / Run tests",
                  url: `${url}/checks`,
                  lines: ["(fail) address > keeps the street between steps", "Expected: \"Main St 1\"", "Received: \"\""],
                  error: null,
              }
            : null,
    };
}
