import { describe, expect, test } from "bun:test";
import { formatLedgerReason } from "@app/utils/ui/components/youtube/ledger-copy";

describe("formatLedgerReason", () => {
    test("exact reasons get friendly labels", () => {
        expect(formatLedgerReason("register-grant").label).toBe("Welcome bonus");
        expect(formatLedgerReason("transcribe:ai").label).toBe("AI transcription");
        expect(formatLedgerReason("qa:channel").label).toBe("Channel question");
    });

    test("id-suffixed reasons resolve by prefix", () => {
        expect(formatLedgerReason("stripe:cs_test_123").label).toBe("Diamond pack");
        expect(formatLedgerReason("sub-allowance:in_9xy").label).toBe("Monthly allowance");
        expect(formatLedgerReason("stripe-refund:ch_1").label).toBe("Refund");
    });

    test("referral distinguishes the two sides", () => {
        expect(formatLedgerReason("referral:42:referrer").label).toBe("Referral reward");
        expect(formatLedgerReason("referral:42:referee").label).toBe("Referral bonus");
    });

    test("unknown reasons de-slug rather than showing raw tokens", () => {
        expect(formatLedgerReason("some-new_reason")).toEqual({ label: "Some new reason" });
    });
});
