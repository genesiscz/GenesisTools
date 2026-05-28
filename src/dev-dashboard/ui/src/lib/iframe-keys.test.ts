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
                term: {
                    scrollLines: () => {
                        throw new Error("should not call term.scrollLines when helper exists");
                    },
                },
            },
            contentDocument: null,
        } as unknown as HTMLIFrameElement;

        expect(scrollIframeTerminal(iframe, -12)).toBe(true);
        expect(scrolled).toBe(-12);
    });

    test("scrollIframeTerminal falls back to iframe WheelEvent", () => {
        let wheelDelta = 0;
        const viewport = {
            parentElement: {
                querySelector: () => ({ getBoundingClientRect: () => ({ height: 20 }) }),
            },
            clientHeight: 400,
            dispatchEvent: (event: Event) => {
                wheelDelta = (event as WheelEvent).deltaY;
                return true;
            },
        };

        class FakeWheelEvent extends Event {
            deltaY: number;
            deltaMode: number;

            constructor(type: string, init: { deltaY: number; deltaMode: number; bubbles: boolean; cancelable: boolean }) {
                super(type, init);
                this.deltaY = init.deltaY;
                this.deltaMode = init.deltaMode;
            }
        }

        const iframe = {
            clientHeight: 400,
            contentWindow: {
                WheelEvent: FakeWheelEvent,
                term: undefined,
            },
            contentDocument: {
                querySelector: () => viewport,
            },
        } as unknown as HTMLIFrameElement;

        expect(scrollIframeTerminal(iframe, 3)).toBe(true);
        expect(wheelDelta).toBe(60);
    });
});
