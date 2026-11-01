import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { embedArgvMode } from "./embed";
import { CodexEmbedProxy, EMBED_REQUEST_PREFIX, type EmbedProxyAccount, LineSplitter } from "./embed-proxy";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (text: string) => encoder.encode(text);
const texts = (lines: Uint8Array[]) => lines.map((line) => decoder.decode(line));

function fakeAccount(overrides: Partial<EmbedProxyAccount> = {}): EmbedProxyAccount & { refreshes: unknown[] } {
    const refreshes: unknown[] = [];

    return {
        refreshes,
        async authenticate(client) {
            const result = await client.request<{ type: string }>("account/login/start", {
                type: "chatgptAuthTokens",
                accessToken: "token-a",
                chatgptAccountId: "workspace-a",
            });

            if (result.type !== "chatgptAuthTokens") {
                throw new Error("login refused");
            }
        },
        async refresh(previous) {
            refreshes.push(previous);
            return { accessToken: "token-b", chatgptAccountId: "workspace-a" };
        },
        ...overrides,
    };
}

function harness(account: EmbedProxyAccount = fakeAccount()) {
    const toChild: Uint8Array[] = [];
    const toHost: Uint8Array[] = [];
    const failures: Error[] = [];
    let childEnded = 0;
    const proxy = new CodexEmbedProxy({
        account,
        toChild: (line) => toChild.push(line),
        endChild: () => {
            childEnded++;
        },
        toHost: (line) => toHost.push(line),
        onLoginFailed: (error) => failures.push(error),
        loginTimeoutMs: 1000,
    });

    return { proxy, toChild, toHost, failures, childEnded: () => childEnded };
}

/** The proxy's own request, as the app-server received it. */
function injected(lines: Uint8Array[]): { id: string; method: string; params: Record<string, unknown> } {
    const line = texts(lines).find((text) => text.includes(EMBED_REQUEST_PREFIX));

    if (!line) {
        throw new Error("no injected request");
    }

    return SafeJSON.parse(line, { strict: true });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("LineSplitter", () => {
    it("joins a line split across chunks, inside a multi-byte character, byte for byte", () => {
        const line = bytes('{"text":"žluťoučký"}\n');
        const splitter = new LineSplitter();
        const cut = line.indexOf(0xc5) + 1;

        expect(splitter.push(line.subarray(0, cut))).toEqual([]);
        const [joined] = splitter.push(line.subarray(cut));

        expect(joined).toEqual(line);
    });

    it("returns every complete line of a chunk and keeps the tail for flush", () => {
        const splitter = new LineSplitter();

        expect(texts(splitter.push(bytes("a\nb\r\nc")))).toEqual(["a\n", "b\r\n"]);
        expect(decoder.decode(splitter.flush())).toBe("c");
        expect(splitter.flush()).toBeUndefined();
    });
});

describe("CodexEmbedProxy", () => {
    it("passes unrelated lines both ways unchanged, odd spacing and non-JSON included", () => {
        const { proxy, toChild, toHost } = harness();
        const hostLines = ['{ "id" : 1, "method":"initialize" }\n', "not json\n"];
        const childLines = ['{"id":1,"result":{"userAgent":"codex/1"}}\n', '{"method":"thread/started" }\n'];

        for (const line of hostLines) {
            proxy.hostLine(bytes(line));
        }

        for (const line of childLines) {
            proxy.childLine(bytes(line));
        }

        expect(texts(toChild)).toEqual(hostLines);
        expect(texts(toHost)).toEqual(childLines);
    });

    it("logs in right after initialized, holds the host's next lines, and hides the login response", async () => {
        const { proxy, toChild, toHost } = harness();

        proxy.hostLine(bytes('{"method":"initialized"}\n'));
        proxy.hostLine(bytes('{"id":2,"method":"account/read","params":{}}\n'));
        await flush();

        const login = injected(toChild);

        expect(login.method).toBe("account/login/start");
        expect(login.params).toEqual({
            type: "chatgptAuthTokens",
            accessToken: "token-a",
            chatgptAccountId: "workspace-a",
        });
        expect(texts(toChild)).not.toContain('{"id":2,"method":"account/read","params":{}}\n');

        proxy.childLine(bytes(`{"id":"${login.id}","result":{"type":"chatgptAuthTokens"}}\n`));
        await flush();

        expect(texts(toChild).at(-1)).toBe('{"id":2,"method":"account/read","params":{}}\n');
        expect(texts(toHost)).toEqual([]);
    });

    it("answers a token refresh from the vault and never shows it to the host", async () => {
        const account = fakeAccount();
        const { proxy, toChild, toHost } = harness(account);

        proxy.childLine(
            bytes(
                '{"id":7,"method":"account/chatgptAuthTokens/refresh","params":{"reason":"unauthorized","previousAccountId":"workspace-a"}}\n'
            )
        );
        await flush();

        expect(account.refreshes).toEqual(["workspace-a"]);
        expect(toHost).toEqual([]);
        expect(SafeJSON.parse(decoder.decode(toChild[0]), { strict: true })).toEqual({
            id: 7,
            result: { accessToken: "token-b", chatgptAccountId: "workspace-a" },
        });
    });

    it("passes a host line that only mentions the refresh method or the id prefix", () => {
        const { proxy, toHost } = harness();
        const line = `{"method":"item/delta","params":{"text":"account/chatgptAuthTokens/refresh ${EMBED_REQUEST_PREFIX}1"}}\n`;

        proxy.childLine(bytes(line));

        expect(texts(toHost)).toEqual([line]);
    });

    it("reports a refused login and releases nothing", async () => {
        const { proxy, toChild, failures } = harness();

        proxy.hostLine(bytes('{"method":"initialized"}\n'));
        proxy.hostLine(bytes('{"id":2,"method":"thread/start"}\n'));
        await flush();
        proxy.childLine(bytes(`{"id":"${injected(toChild).id}","error":{"code":-32600,"message":"bad token"}}\n`));
        await flush();

        expect(failures.map((error) => error.message)).toEqual(["bad token"]);
        expect(texts(toChild).some((text) => text.includes("thread/start"))).toBe(false);
    });

    it("closes the app-server's stdin only after the held lines went out", async () => {
        const { proxy, toChild, childEnded } = harness();

        proxy.hostLine(bytes('{"method":"initialized"}\n'));
        proxy.hostLine(bytes('{"id":2,"method":"account/read"}\n'));
        proxy.hostEnd();
        await flush();

        expect(childEnded()).toBe(0);
        proxy.childLine(bytes(`{"id":"${injected(toChild).id}","result":{"type":"chatgptAuthTokens"}}\n`));
        await flush();

        expect(texts(toChild).at(-1)).toBe('{"id":2,"method":"account/read"}\n');
        expect(childEnded()).toBe(1);
    });
});

describe("embedArgvMode", () => {
    it("serves a plain app-server and one with harmless options", () => {
        expect(embedArgvMode(["app-server"])).toBe("serve");
        expect(embedArgvMode(["app-server", "-c", 'model="gpt-5"', "--enable", "x", "--listen", "stdio://"])).toBe(
            "serve"
        );
    });

    it("runs inspection commands natively", () => {
        expect(embedArgvMode(["--version"])).toBe("native");
        expect(embedArgvMode(["exec", "-"])).toBe("native");
        expect(embedArgvMode(["app-server", "--help"])).toBe("native");
        expect(embedArgvMode(["app-server", "generate-ts", "--out", "x"])).toBe("native");
    });

    it("refuses launches that would change where the login comes from", () => {
        expect(() => embedArgvMode(["app-server", "--startup-sign-out"])).toThrow(/startup-sign-out/);
        expect(() => embedArgvMode(["app-server", "-c", 'cli_auth_credentials_store="file"'])).toThrow(
            /cli_auth_credentials_store/
        );
        expect(() => embedArgvMode(["app-server", "--config=model_provider=x"])).toThrow(/model_provider/);
        expect(() => embedArgvMode(["app-server", "-cprofile=x"])).toThrow(/profile/);
        expect(() => embedArgvMode(["app-server", "--listen", "ws://127.0.0.1:1"])).toThrow(/stdio/);
        expect(() => embedArgvMode(["app-server", "daemon"])).toThrow(/app-server daemon/);
        expect(() => embedArgvMode(["-c", "x=1", "app-server"])).toThrow(/first/);
    });
});
