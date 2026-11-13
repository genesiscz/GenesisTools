import { afterEach, expect, it, mock } from "bun:test";

mock.module("react-native", () => ({ View: "View", Text: "Text" }));
const replaced: string[] = [];
mock.module("expo-router", () => ({ router: { replace: (to: string) => replaced.push(to) } }));
mock.module("@/transport/tiers", () => ({
    TIERS: { "cloudflared-self": { pairing: "none" }, managed: { pairing: "device-code" } },
}));
let challenge = false;
mock.module("@/transport/probe", () => ({ asksForPassword: async () => challenge }));
type Result = { ok: boolean; error?: string };
const applied: string[] = [];
let answer: () => Promise<Result> = async () => ({ ok: false, error: "The Mac did not answer." });
mock.module("@/lib/apply-pairing", () => ({
    applyPairingUri: (uri: string) => {
        applied.push(uri);
        return answer();
    },
}));

const { act, cleanup, renderHook, waitFor } = await import("@testing-library/react-native/pure");
const { usePairingLink } = await import("./use-pairing-link");
type Params = Parameters<typeof usePairingLink>[0];
afterEach(cleanup);

const tunnel = (baseUrl: string): Params => ({ tier: "cloudflared-self", baseUrl, username: "phone" });

it("shows a managed link's address before it asks for the code, and connects nothing on confirm", async () => {
    applied.length = 0;
    const hook = await renderHook(() => usePairingLink({ tier: "managed", baseUrl: "https://relay.example.com", username: "phone", pk: "key" }));
    expect(hook.result.current.confirming).toBe(true);
    expect(hook.result.current.asking).toBe(false);
    await act(async () => hook.result.current.confirm());
    expect(hook.result.current.asking).toBe(true);
    expect(applied).toEqual([]);
});

it("asks a tunnel for its password only when the Mac answered 401", async () => {
    for (const asks of [false, true]) {
        challenge = asks;
        answer = async () => ({ ok: false, error: "The Mac did not answer." });
        const hook = await renderHook(() => usePairingLink(tunnel("https://a.example.com")));
        await act(async () => hook.result.current.confirm());
        await waitFor(() => expect(hook.result.current.busy).toBe(false));
        await waitFor(() => expect(hook.result.current.asking).toBe(asks));
        expect(hook.result.current.error).toBe("The Mac did not answer.");
        await hook.unmount();
    }
});

it("ignores the completion of a link that a newer link replaced", async () => {
    replaced.length = 0;
    let finish: (result: Result) => void = () => {};
    answer = () => new Promise<Result>((resolve) => {
        finish = resolve;
    });
    const hook = await renderHook((params: Params) => usePairingLink(params), { initialProps: tunnel("https://a.example.com") });
    await act(async () => hook.result.current.confirm());
    await hook.rerender(tunnel("https://b.example.com"));
    await act(async () => finish({ ok: true }));
    expect(replaced).toEqual([]);
    expect(hook.result.current.confirming).toBe(true);
    expect(hook.result.current.pairing?.baseUrl).toBe("https://b.example.com");
    expect(hook.result.current.busy).toBe(false);
});
