import { describe, expect, test } from "bun:test";
import { scrollIframeTerminal } from "@/lib/iframe-keys";

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
        const iframe = {
            contentWindow: {
                postMessage: (data: unknown) => {
                    posted = data;
                },
            },
            contentDocument: null,
        } as unknown as HTMLIFrameElement;

        expect(scrollIframeTerminal(iframe, 5)).toBe(true);
        expect(posted).toEqual({ type: "dd-ttyd-scroll", lines: 5 });
    });
});
