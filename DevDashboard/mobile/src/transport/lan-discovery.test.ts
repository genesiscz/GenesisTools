import { expect, it, mock } from "bun:test";

mock.module("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
mock.module("react-native-zeroconf", () => ({ default: class {} }));

const { toAgent, urlHostOf } = await import("@/transport/lan-discovery");

it("puts an IPv4 address first, and an IPv6 literal in brackets so the URL parses", () => {
    expect(urlHostOf({ addresses: ["2001:db8::5", "192.168.1.5"], host: "mac.local." })).toBe("192.168.1.5");
    const agent = toAgent({ name: "Mac", addresses: ["2001:db8::5"], host: "mac.local.", port: 3042 });
    expect(agent?.baseUrl).toBe("http://[2001:db8::5]:3042");
    expect(new URL(`http://${agent?.host}:${agent?.port}`).port).toBe("3042");
});

it("falls back to the mDNS host name when the only IPv6 address is link-local", () => {
    expect(urlHostOf({ addresses: ["fe80::1234"], host: "mac.local." })).toBe("mac.local");
});
