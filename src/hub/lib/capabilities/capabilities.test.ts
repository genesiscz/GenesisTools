import { describe, expect, it } from "bun:test";
import {
    CapabilityRefusedError,
    HUB_CAPABILITIES,
    type HubCapability,
    type HubCapabilityName,
    runCapability,
    TRANSCRIPT_PAGE_MAX,
} from "./index";

function refusal(run: () => unknown): { code: string; message: string } | null {
    try {
        run();
        return null;
    } catch (err) {
        if (err instanceof CapabilityRefusedError) {
            return { code: err.code, message: err.message };
        }

        throw err;
    }
}

describe("hub capabilities", () => {
    it("every capability is a read that keeps the door rules (checked data, not a comment)", () => {
        for (const [name, capability] of Object.entries(HUB_CAPABILITIES)) {
            expect({ name, policy: capability.policy, rules: capability.rules }).toEqual({
                name,
                policy: "read",
                rules: {
                    tccGated: false,
                    interactive: false,
                    spendsCredential: false,
                    startsLongLivedChild: false,
                    writes: "none",
                },
            });
        }
    });

    it("forecast, procs and prompts take no input", () => {
        for (const name of ["forecast", "procs", "prompts"] as const satisfies HubCapabilityName[]) {
            const capability: HubCapability = HUB_CAPABILITIES[name];
            expect(capability.parse({ anything: "ignored" })).toEqual({});
        }
    });

    it("stuck needs full session ids, as a comma list or an array", () => {
        expect(HUB_CAPABILITIES.stuck.parse({ sessions: "s-one, s-two" })).toEqual({ sessionIds: ["s-one", "s-two"] });
        expect(HUB_CAPABILITIES.stuck.parse({ sessions: ["s-one"] })).toEqual({ sessionIds: ["s-one"] });
        expect(refusal(() => HUB_CAPABILITIES.stuck.parse({}))?.code).toBe("bad-input");
        expect(refusal(() => HUB_CAPABILITIES.stuck.parse({ sessions: "--all" }))?.code).toBe("bad-input");
    });

    it("agents reads since and limit with the CLI's own parsers", () => {
        expect(HUB_CAPABILITIES.agents.parse({ since: "24h", limit: "5", session: "s-one" })).toEqual({
            hours: 24,
            limit: 5,
            session: "s-one",
            agent: undefined,
        });
        expect(refusal(() => HUB_CAPABILITIES.agents.parse({ since: "soon" }))?.message).toContain("since:");
        expect(refusal(() => HUB_CAPABILITIES.agents.parse({ limit: "0" }))?.message).toContain("limit:");
        // A typed caller sends numbers; they read as the same CLI values, never as absent.
        expect(HUB_CAPABILITIES.agents.parse({ limit: 5 }).limit).toBe(5);
        expect(refusal(() => HUB_CAPABILITIES.agents.parse({ limit: 0 }))?.message).toContain("limit:");
    });

    it("transcript needs a query, defaults the page to 80 and refuses an unknown provider", () => {
        expect(HUB_CAPABILITIES.transcript.parse({ query: "s-one" })).toEqual({
            query: "s-one",
            limit: 80,
            offset: undefined,
            provider: undefined,
        });
        expect(
            HUB_CAPABILITIES.transcript.parse({ query: "s-one", limit: "5", offset: "10", provider: "codex" })
        ).toEqual({ query: "s-one", limit: 5, offset: 10, provider: "codex" });
        expect(refusal(() => HUB_CAPABILITIES.transcript.parse({}))?.code).toBe("bad-input");
        expect(refusal(() => HUB_CAPABILITIES.transcript.parse({ query: "s", provider: "nope" }))?.code).toBe(
            "bad-input"
        );
        expect(refusal(() => HUB_CAPABILITIES.transcript.parse({ query: "s", limit: "1.5" }))?.code).toBe("bad-input");
        // A page past the cap is refused before anything is read, so a request cannot hydrate a whole session.
        expect(HUB_CAPABILITIES.transcript.parse({ query: "s", limit: TRANSCRIPT_PAGE_MAX }).limit).toBe(
            TRANSCRIPT_PAGE_MAX
        );
        expect(
            refusal(() => HUB_CAPABILITIES.transcript.parse({ query: "s", limit: TRANSCRIPT_PAGE_MAX + 1 }))?.code
        ).toBe("bad-input");
    });

    it("widget snapshot takes an optional selected key", () => {
        expect(HUB_CAPABILITIES.widgetSnapshot.parse({ selected: "claude/s-one" })).toEqual({
            selected: "claude/s-one",
        });
        expect(HUB_CAPABILITIES.widgetSnapshot.parse({})).toEqual({ selected: undefined });
    });

    it("prompts runs through the module: the saved prompts, most used first", async () => {
        const prompts = await runCapability("prompts", {}, { signal: new AbortController().signal });

        expect(Array.isArray(prompts)).toBe(true);
    });

    it("a cancelled call stops before its work", async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(runCapability("forecast", {}, { signal: controller.signal })).rejects.toThrow();
    });
});
