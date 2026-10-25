import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { planMarketplaceAction, pluginStepDecision } from "./marketplace";

const CHECKOUT = "/Users/me/GenesisTools";

function plan(args: Parameters<typeof planMarketplaceAction>[0] extends infer T ? Omit<T, "resolvePath"> : never) {
    return planMarketplaceAction({ ...args, resolvePath: resolve });
}

describe("pluginStepDecision", () => {
    it("never prompts without a terminal: it runs the default instead", () => {
        expect(pluginStepDecision({ hasClaude: true, plugins: true, interactive: false })).toBe("run");
    });

    it("asks on a terminal", () => {
        expect(pluginStepDecision({ hasClaude: true, plugins: true, interactive: true })).toBe("ask");
    });

    it("skips with --no-plugins or without a claude binary", () => {
        expect(pluginStepDecision({ hasClaude: true, plugins: false, interactive: false })).toBe("skip");
        expect(pluginStepDecision({ hasClaude: false, plugins: true, interactive: true })).toBe("skip");
    });
});

describe("planMarketplaceAction", () => {
    it("registers the checkout when no marketplace exists yet", () => {
        expect(plan({ isCheckout: true, checkout: CHECKOUT, lookup: { status: "absent" } })).toEqual({
            action: "add-checkout",
            repointed: false,
        });
    });

    it("re-points an existing git-sourced marketplace at the checkout", () => {
        expect(
            plan({
                isCheckout: true,
                checkout: CHECKOUT,
                lookup: { status: "found", entry: { name: "genesis-tools", source: "github" } },
            })
        ).toEqual({ action: "add-checkout", repointed: true });
    });

    it("only refreshes when the marketplace already points at this checkout", () => {
        expect(
            plan({
                isCheckout: true,
                checkout: CHECKOUT,
                lookup: { status: "found", entry: { name: "genesis-tools", source: "directory", path: CHECKOUT } },
            })
        ).toEqual({ action: "refresh", repointed: false });
    });

    it("treats a trailing-slash directory path as the same checkout", () => {
        expect(
            plan({
                isCheckout: true,
                checkout: CHECKOUT,
                lookup: {
                    status: "found",
                    entry: { name: "genesis-tools", source: "directory", path: `${CHECKOUT}/` },
                },
            })
        ).toEqual({ action: "refresh", repointed: false });
    });

    it("falls back to the GitHub marketplace outside a checkout with nothing registered", () => {
        expect(plan({ isCheckout: false, checkout: "/tmp/elsewhere", lookup: { status: "absent" } })).toEqual({
            action: "add-fallback",
            repointed: false,
        });
    });

    it("leaves an existing registration alone outside a checkout", () => {
        expect(
            plan({
                isCheckout: false,
                checkout: "/tmp/elsewhere",
                lookup: { status: "found", entry: { name: "genesis-tools", source: "github" } },
            })
        ).toEqual({ action: "refresh", repointed: false });
    });

    // The regression this split exists for: a failed `marketplace list` used to look exactly
    // like "no marketplace registered", and `marketplace add` overwrites rather than refusing.
    it("never adds when the lookup failed, even inside a checkout", () => {
        const result = plan({ isCheckout: true, checkout: CHECKOUT, lookup: { status: "unknown" } });

        expect(result.action).toBe("refresh");
        expect(result.repointed).toBe(false);
        expect(result.reason).toContain("Could not read");
    });

    it("never adds the fallback when the lookup failed outside a checkout", () => {
        expect(plan({ isCheckout: false, checkout: "/tmp/elsewhere", lookup: { status: "unknown" } }).action).toBe(
            "refresh"
        );
    });
});
