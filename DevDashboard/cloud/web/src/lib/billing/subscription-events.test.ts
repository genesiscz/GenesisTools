import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The webhook's state transitions, with the store mocked out. `mapStatus` is the load-bearing part:
 * an unrecognized Stripe status must never come back entitled, so every status in the union is
 * asserted here rather than left to a `default` branch.
 */

const updateSubscription = vi.fn();

vi.mock("@/lib/db/cloud-store", () => ({
    cloudStore: {
        updateSubscription: (...args: unknown[]) => updateSubscription(...args),
    },
}));

const { handleEvent, mapStatus } = await import("./subscription-events");

// Stripe's own event/object types carry ~60 required fields; a fixture builder keeps the single
// unavoidable cast in one place instead of at every call site.
function checkoutEvent(session: Partial<Stripe.Checkout.Session>): Stripe.Event {
    return { type: "checkout.session.completed", data: { object: session } } as unknown as Stripe.Event;
}

function subscriptionEvent(
    type: "customer.subscription.updated" | "customer.subscription.deleted",
    subscription: Partial<Stripe.Subscription>
): Stripe.Event {
    return { type, data: { object: subscription } } as unknown as Stripe.Event;
}

describe("mapStatus", () => {
    it("entitles only the statuses Stripe considers paid", () => {
        expect(mapStatus("active")).toBe("active");
        expect(mapStatus("trialing")).toBe("trialing");
    });

    it("never returns 'active' for a non-entitled status", () => {
        const notEntitled: Stripe.Subscription.Status[] = [
            "past_due",
            "unpaid",
            "incomplete",
            "incomplete_expired",
            "paused",
            "canceled",
        ];

        for (const status of notEntitled) {
            expect(mapStatus(status)).not.toBe("active");
        }
    });

    it("maps an unpaid-but-recoverable status to past_due and a dead one to canceled", () => {
        expect(mapStatus("incomplete")).toBe("past_due");
        expect(mapStatus("paused")).toBe("past_due");
        expect(mapStatus("incomplete_expired")).toBe("canceled");
    });
});

describe("handleEvent", () => {
    beforeEach(() => {
        updateSubscription.mockClear();
    });

    it("checkout completion upgrades the tier named in the session metadata", async () => {
        await handleEvent(
            checkoutEvent({
                client_reference_id: "acct-1",
                metadata: { tier: "pro" },
                customer: "cus_123",
                subscription: "sub_123",
            })
        );

        expect(updateSubscription).toHaveBeenCalledWith("acct-1", {
            tier: "pro",
            status: "active",
            stripeCustomerId: "cus_123",
            stripeSubscriptionId: "sub_123",
        });
    });

    it("checkout completion without an account reference writes nothing", async () => {
        await handleEvent(checkoutEvent({ metadata: { tier: "pro" } }));
        expect(updateSubscription).not.toHaveBeenCalled();
    });

    it("checkout completion with an unknown tier writes nothing", async () => {
        await handleEvent(checkoutEvent({ client_reference_id: "acct-1", metadata: { tier: "enterprise" } }));
        expect(updateSubscription).not.toHaveBeenCalled();
    });

    it("subscription.updated maps the Stripe status onto the row", async () => {
        await handleEvent(
            subscriptionEvent("customer.subscription.updated", {
                status: "past_due",
                metadata: { accountId: "acct-1" },
            })
        );

        expect(updateSubscription).toHaveBeenCalledWith("acct-1", { status: "past_due", tier: undefined });
    });

    it("an incomplete subscription does not leave the account entitled", async () => {
        await handleEvent(
            subscriptionEvent("customer.subscription.updated", {
                status: "incomplete",
                metadata: { accountId: "acct-1" },
            })
        );

        expect(updateSubscription).toHaveBeenCalledWith("acct-1", { status: "past_due", tier: undefined });
    });

    it("subscription.deleted resets the account to free/canceled", async () => {
        await handleEvent(
            subscriptionEvent("customer.subscription.deleted", {
                status: "active",
                metadata: { accountId: "acct-1" },
            })
        );

        expect(updateSubscription).toHaveBeenCalledWith("acct-1", { status: "canceled", tier: "free" });
    });

    it("a subscription event without an accountId in metadata writes nothing", async () => {
        await handleEvent(subscriptionEvent("customer.subscription.updated", { status: "active" }));
        expect(updateSubscription).not.toHaveBeenCalled();
    });

    it("an unrelated event type writes nothing", async () => {
        await handleEvent({ type: "invoice.paid", data: { object: {} } } as unknown as Stripe.Event);
        expect(updateSubscription).not.toHaveBeenCalled();
    });

    it("a redelivered event converges on the same patch rather than compounding", async () => {
        const event = subscriptionEvent("customer.subscription.updated", {
            status: "past_due",
            metadata: { accountId: "acct-1" },
        });

        await handleEvent(event);
        await handleEvent(event);

        // The handler has no dedupe of its own; what makes redelivery safe is that every write is an
        // absolute SET, so the second call asks for exactly the state the first one already produced.
        expect(updateSubscription).toHaveBeenCalledTimes(2);
        expect(updateSubscription.mock.calls[0]).toEqual(updateSubscription.mock.calls[1]);
    });
});
