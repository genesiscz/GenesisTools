import { describe, expect, test } from "bun:test";
import { type AddressInfo, createServer } from "node:net";
import { classFromContentType, classifyBodyPeek, probeHttp } from "./probe";

describe("probeHttp", () => {
    test("asks the probed server to close the connection", async () => {
        // A bare WebSocket server (browsermcp on 9009) answers plain GET with 426 and
        // node's default 5s keep-alive. Without this header the pooled idle socket
        // lists the whole dashboard in `lsof -ti:9009`, which browsermcp kill -9s.
        let request = "";
        const server = createServer((socket) => {
            socket.on("data", (chunk) => {
                request += chunk.toString();
                socket.end(
                    "HTTP/1.1 426 Upgrade Required\r\ncontent-type: text/plain\r\ncontent-length: 16\r\n\r\nUpgrade Required"
                );
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;

        try {
            const result = await probeHttp(port);
            expect(result.http).toBe(true);
            expect(request.toLowerCase()).toContain("connection: close");
        } finally {
            server.close();
        }
    });
});

describe("classFromContentType", () => {
    test("html / json / text", () => {
        expect(classFromContentType("text/html; charset=utf-8")).toBe("html");
        expect(classFromContentType("application/json")).toBe("json");
        expect(classFromContentType("text/plain")).toBe("text");
        expect(classFromContentType("application/octet-stream")).toBeNull();
    });
});

describe("classifyBodyPeek", () => {
    test("sniffs html and json", () => {
        expect(classifyBodyPeek("<!DOCTYPE html><html>")).toBe("html");
        expect(classifyBodyPeek('{"ok":true}')).toBe("json");
        expect(classifyBodyPeek("hello world")).toBe("text");
    });
});
