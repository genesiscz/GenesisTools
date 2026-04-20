import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNetstatStates, parseUtunInterfaces } from "@app/doctor/analyzers/network";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("parseNetstatStates", () => {
    it("counts TCP states from netstat output", () => {
        const raw = readFileSync(join(FIXTURES, "netstat-an.txt"), "utf8");
        const counts = parseNetstatStates(raw);

        expect(counts.ESTABLISHED).toBe(2);
        expect(counts.TIME_WAIT).toBe(1);
        expect(counts.CLOSE_WAIT).toBe(1);
    });
});

describe("parseUtunInterfaces", () => {
    it("finds utun interface blocks", () => {
        const raw = [
            "utun0: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST>",
            "",
            "en0: flags=8863<UP>",
            "",
            "utun1: flags=8051<UP>",
        ].join("\n");

        expect(parseUtunInterfaces(raw)).toEqual(["utun0", "utun1"]);
    });
});
