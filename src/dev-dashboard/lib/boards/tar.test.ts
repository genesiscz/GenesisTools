import { describe, expect, it } from "bun:test";
import { tarGz, untarGz } from "./tar";

describe("tar codec", () => {
    it("round-trips entries through tarGz -> untarGz", async () => {
        const entries = [
            { path: "a.txt", data: new TextEncoder().encode("hello") },
            { path: "sub/b.png", data: new Uint8Array([1, 2, 3, 4, 5]) },
        ];
        const gz = await tarGz(entries);
        const out = await untarGz(gz);
        expect(out.length).toBe(2);
        const a = out.find((e) => e.path === "a.txt");
        const b = out.find((e) => e.path === "sub/b.png");
        expect(a?.data).toEqual(entries[0].data);
        expect(b?.data).toEqual(entries[1].data);
    });

    it("drops traversal / absolute-path entries", async () => {
        const gz = await tarGz([
            { path: "../evil", data: new Uint8Array([1]) },
            { path: "/abs/evil", data: new Uint8Array([2]) },
            { path: "ok.txt", data: new Uint8Array([3]) },
        ]);
        const out = await untarGz(gz);
        expect(out.map((e) => e.path)).toEqual(["ok.txt"]);
    });
});
