import { describe, expect, test } from "bun:test";
import { parseLsofListen } from "./scanner";

const FIXTURE = [
    "COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
    "rapportd    711 Martin   10u  IPv4 0x8b160b4fe7f3824d      0t0  TCP *:53357 (LISTEN)",
    "rapportd    711 Martin   11u  IPv6 0x84a01adc303d0215      0t0  TCP *:53357 (LISTEN)",
    "node       1307 Martin   18u  IPv4 0xa4528e4de8db5a64      0t0  TCP 127.0.0.1:18789 (LISTEN)",
    "node       1307 Martin   19u  IPv6 0x3486ea0eed65f93d      0t0  TCP [::1]:18789 (LISTEN)",
    "bun        1321 Martin    7u  IPv4 0xf7ff0254c4e99697      0t0  TCP 127.0.0.1:3074 (LISTEN)",
    "php-fpm    1331 Martin    9u  IPv4 0x571546a4f62a8e3b      0t0  TCP 127.0.0.1:9000 (LISTEN)",
    "",
].join("\n");

describe("parseLsofListen", () => {
    test("parses ports across IPv4/IPv6 and multiple PIDs, sorted by port", () => {
        const result = parseLsofListen(FIXTURE);

        // 7 LISTEN rows → 6 entries after deduping (rapportd :53357 v4+v6 share pid+port → kept as
        // two distinct proto rows; node :18789 v4+v6 → two distinct proto rows). Dedup is per
        // (pid, port, proto): no exact duplicate in the fixture, so all 6 unique rows survive,
        // sorted ascending by port.
        expect(result.map((p) => p.port)).toEqual([3074, 9000, 18789, 18789, 53357, 53357]);
    });

    test("extracts pid, command (truncated ok), address and proto", () => {
        const result = parseLsofListen(FIXTURE);
        const bun = result.find((p) => p.port === 3074);
        expect(bun).toEqual({ port: 3074, pid: 1321, command: "bun", address: "127.0.0.1", proto: "tcp4" });

        const phpFpm = result.find((p) => p.port === 9000);
        expect(phpFpm?.command).toBe("php-fpm");

        const node6 = result.find((p) => p.port === 18789 && p.proto === "tcp6");
        expect(node6?.address).toBe("[::1]");
    });

    test("dedupes an exact (pid, port, proto) repeat", () => {
        const dup = [
            "node       1307 Martin   18u  IPv4 0xaaaa      0t0  TCP 127.0.0.1:18789 (LISTEN)",
            "node       1307 Martin   20u  IPv4 0xbbbb      0t0  TCP 127.0.0.1:18789 (LISTEN)",
        ].join("\n");
        expect(parseLsofListen(dup)).toHaveLength(1);
    });

    test("skips the header and blank lines; empty input → []", () => {
        expect(parseLsofListen("")).toEqual([]);
        expect(parseLsofListen("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n")).toEqual([]);
    });
});
