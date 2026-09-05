import { describe, expect, test } from "bun:test";
import { nativeSessionRoots } from "@genesiscz/utils/providers/session-paths";
import type { AccountEntry } from "../../../config/schema";
import { anthropicSpendScope } from "./spend";

function account(id: string, name: string): AccountEntry {
    return { id, name, provider: "anthropic-sub", credentials: {} } as AccountEntry;
}

describe("anthropicSpendScope", () => {
    test("every account gets the same shared tree, which is why claude cannot be split", () => {
        const work = anthropicSpendScope(account("acc_work", "work"));
        const personal = anthropicSpendScope(account("acc_personal", "personal"));

        expect(work.source).toBe("claude");
        expect(work.transcriptRoots).toEqual(nativeSessionRoots("claude"));
        expect(personal.transcriptRoots).toEqual(work.transcriptRoots);
    });
});
