import { expect, test } from "bun:test";
import { parsePageSnapshot } from "./page-snapshot";

test("parses uid role name lines and JSON nodes", () => {
    const lines = parsePageSnapshot(`uid=1_2 button "Export"\n1_3 link "Docs"`);
    expect(lines).toEqual([
        { uid: "1_2", role: "button", name: "Export" },
        { uid: "1_3", role: "link", name: "Docs" },
    ]);
    expect(parsePageSnapshot(`[{"uid":"a","role":"button","name":"Go"}]`)).toEqual([
        { uid: "a", role: "button", name: "Go" },
    ]);
});

test("rejects empty snapshots", () => {
    expect(parsePageSnapshot("")).toEqual([]);
});
