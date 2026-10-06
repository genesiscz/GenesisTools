import { describe, expect, test } from "bun:test";
import { pasteTextToIframe, scrollIframeTerminal, scrollIframeTerminalByPage } from "@/lib/iframe-keys";

describe("iframe-keys scroll", () => {
    test("scrollIframeTerminal prefers __ddTtydScroll in iframe realm", () => {
        let scrolled = 0;
        const iframe = {
            contentWindow: {
                __ddTtydScroll: (lines: number) => {
                    scrolled = lines;
                    return true;
                },
            },
            contentDocument: null,
        } as unknown as HTMLIFrameElement;

        expect(scrollIframeTerminal(iframe, -12)).toBe(true);
        expect(scrolled).toBe(-12);
    });

    test("scrollIframeTerminal falls back to postMessage before injection is ready", () => {
        let posted: unknown = null;
        let targetOrigin: string | undefined;
        const iframe = {
            src: "https://dashboard.test/ttyd/synthetic/",
            contentWindow: {
                postMessage: (data: unknown, target: string) => {
                    posted = data;
                    targetOrigin = target;
                },
            },
            contentDocument: null,
        } as unknown as HTMLIFrameElement;

        expect(scrollIframeTerminal(iframe, 5)).toBe(true);
        expect(posted).toEqual({ type: "dd-ttyd-scroll", lines: 5 });
        expect(targetOrigin).toBe("https://dashboard.test");
    });

    test("scrollIframeTerminalByPage prefers __ddTtydScrollPage in iframe realm", () => {
        let direction = 0;
        const iframe = {
            contentWindow: {
                __ddTtydScrollPage: (dir: -1 | 1) => {
                    direction = dir;
                    return true;
                },
            },
            contentDocument: null,
        } as unknown as HTMLIFrameElement;

        expect(scrollIframeTerminalByPage(iframe, -1)).toBe(true);
        expect(direction).toBe(-1);
    });

    test("scrollIframeTerminalByPage falls back to postMessage before injection is ready", () => {
        let posted: unknown = null;
        let targetOrigin: string | undefined;
        const iframe = {
            src: "https://dashboard.test/ttyd/synthetic/",
            contentWindow: {
                postMessage: (data: unknown, target: string) => {
                    posted = data;
                    targetOrigin = target;
                },
            },
            contentDocument: null,
        } as unknown as HTMLIFrameElement;

        expect(scrollIframeTerminalByPage(iframe, 1)).toBe(true);
        expect(posted).toEqual({ type: "dd-ttyd-scroll-page", direction: 1 });
        expect(targetOrigin).toBe("https://dashboard.test");
    });

    test("paste fallback targets only the terminal iframe origin", () => {
        let posted: unknown = null;
        let targetOrigin: string | undefined;
        const iframe = {
            src: "https://dashboard.test/ttyd/synthetic/",
            contentWindow: {
                postMessage: (data: unknown, target: string) => {
                    posted = data;
                    targetOrigin = target;
                },
            },
            contentDocument: null,
        } as unknown as HTMLIFrameElement;

        expect(pasteTextToIframe(iframe, "normal input")).toBe(true);
        expect(posted).toEqual({ type: "dd-ttyd-paste", text: "normal input" });
        expect(targetOrigin).toBe("https://dashboard.test");
    });
});
