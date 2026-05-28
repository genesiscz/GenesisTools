import { describe, expect, it } from "bun:test";
import { ansiToReactNodes } from "./render-ansi.client";

function plainText(nodes: ReturnType<typeof ansiToReactNodes>): string {
    if (typeof nodes === "string") {
        return nodes;
    }

    return nodes
        .map((node) => {
            if (typeof node === "string") {
                return node;
            }

            if (node && typeof node === "object" && "props" in node) {
                const props = node.props as { children?: unknown };
                return typeof props.children === "string" ? props.children : "";
            }

            return "";
        })
        .join("");
}

describe("ansiToReactNodes", () => {
    it("consumes DEC private mode sequences without leaking params", () => {
        expect(plainText(ansiToReactNodes("\u001b[?25lQR\u001b[?25h"))).toBe("QR");
    });

    it("consumes erase-line CSI sequences", () => {
        expect(plainText(ansiToReactNodes("\u001b[2Kline"))).toBe("line");
    });
});
