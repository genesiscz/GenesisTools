import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import {
    byKeys,
    contractShapeMismatches,
    kitFixturePath,
    ndjsonShapeMismatches,
    readKitFixtureJson,
    readKitFixtureLines,
} from "./kit-fixtures";

const contract = {
    id: "a",
    size: 1,
    volume: { path: "/x", bytes: null },
    items: [{ status: "ok", bytes: 1 }],
    meta: { anything: "1" },
};

describe("the contract shape check", () => {
    it("passes the same shape with other values, a null for a scalar, and more elements", () => {
        const actual = {
            id: "b",
            size: null,
            volume: { path: "/y", bytes: 9 },
            items: [
                { status: "ok", bytes: 2 },
                { status: "ok", bytes: 3, extra: undefined },
            ],
            meta: { other: "2" },
        };

        expect(contractShapeMismatches(actual, contract, { openMaps: ["$.meta"] })).toEqual([]);
    });

    it("names a missing key, an extra key, a changed type and a changed nesting at every depth", () => {
        const actual = {
            id: 1,
            size: 1,
            volume: { path: "/x", bytes: { value: 1 } },
            items: [{ status: "ok", bytes: 1 }, { status: "ok" }, { status: "ok", bytes: 1, more: true }],
            meta: { anything: "1" },
            added: true,
        };

        expect(contractShapeMismatches(actual, contract).sort()).toEqual(
            [
                '$: has "added", which the contract does not',
                "$.id: a number where the contract has a string",
                "$.volume.bytes: an object where the contract has null, so its keys go unchecked",
                '$.items[]: missing "bytes", which the contract has',
                '$.items[]: has "more", which the contract does not',
            ].sort()
        );
    });

    it("checks each element against the example of its kind, and names a kind the contract lacks", () => {
        const kinds = { "$.items[]": byKeys("status") };
        const mixed = {
            items: [
                { status: "ok", bytes: 1 },
                { status: "refused", reason: "x" },
            ],
        };

        expect(contractShapeMismatches({ items: [{ status: "refused", reason: "y" }] }, mixed, { kinds })).toEqual([]);
        expect(contractShapeMismatches({ items: [{ status: "refused", bytes: 1 }] }, mixed, { kinds })).toEqual([
            '$.items[refused]: missing "reason", which the contract has',
            '$.items[refused]: has "bytes", which the contract does not',
        ]);
        expect(contractShapeMismatches({ items: [{ status: "staged" }] }, mixed, { kinds })).toEqual([
            '$.items[0]: of kind "staged", which the contract has no example of',
        ]);
    });

    it("an empty array or a null object cannot pass for the contract's elements and keys", () => {
        expect(contractShapeMismatches({ ...contract, items: [] }, contract)).toEqual([
            "$.items: empty, so the keys of the contract's elements go unchecked",
        ]);
        expect(contractShapeMismatches({ ...contract, volume: null }, contract)).toEqual([
            "$.volume: null where the contract has an object, so its keys go unchecked",
        ]);
    });

    it("checks ndjson per event type and names a type that was never produced", () => {
        const lines = [
            { type: "start", at: 1 },
            { type: "item", id: "a" },
            { type: "item", id: "b" },
        ];

        expect(
            ndjsonShapeMismatches(
                [
                    { type: "start", at: 2 },
                    { type: "item", id: "c" },
                ],
                lines
            )
        ).toEqual([]);
        expect(ndjsonShapeMismatches([{ type: "item", id: "c", at: 1 }, { type: "end" }], lines)).toEqual([
            '[item] $: has "at", which the contract does not',
            "[end] the contract has no event of this type",
            "[start] no event of this type was produced",
        ]);
        expect(ndjsonShapeMismatches([{ type: "item", id: "c" }], lines, { types: ["item"] })).toEqual([]);
    });

    it("reads the kit's single copy of the fixtures", () => {
        expect(existsSync(kitFixturePath("contract-du-index-schema.sql"))).toBe(true);
        expect(readKitFixtureJson("contract-doctor-act-result-ok.json")).toMatchObject({ schemaVersion: 1 });
        expect(readKitFixtureLines("contract-doctor-act.ndjson").map(byKeys("type"))).toEqual([
            "plan",
            "item-start",
            "item-done",
            "volume-after",
            "result",
        ]);
    });
});
