import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractImageBytes, findDiskCacheImage, parseAmsObjectId } from "./disk-cache";

const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6300000002000100e5ef27d20000000049454e44ae426082",
    "hex"
);

describe("parseAmsObjectId", () => {
    test("reads the object id from an AMS url", () => {
        const id = parseAmsObjectId(
            "https://eu-api.asm.skype.com/v1/objects/0-weu-d1-0123456789abcdef01234567/views/imgo"
        );
        expect(id).toBe("0-weu-d1-0123456789abcdef01234567");
    });
});

describe("extractImageBytes", () => {
    test("slices a PNG out of a Chromium cache record prefix", () => {
        const record = Buffer.concat([
            Buffer.from("https://example/objects/0-abc/views/imgpsh_fullsize\n"),
            PNG,
            Buffer.from("TRAILER"),
        ]);
        const extracted = extractImageBytes(record);
        expect(extracted?.ext).toBe("png");
        expect(Buffer.from(extracted?.bytes ?? []).equals(PNG)).toBe(true);
    });
});

describe("findDiskCacheImage", () => {
    test("prefers fullsize over imgo", () => {
        const dir = join("/tmp", `ms-teams-cache-${process.pid}`);
        mkdirSync(dir, { recursive: true });
        const header = (view: string) =>
            Buffer.from(
                `1/0/_dk_https://microsoft.com https://eu-prod.asyncgw.teams.microsoft.com/v1/me/objects/0-weu-d1-aabbccddeeff001122334455/views/${view}?v=1`
            );
        writeFileSync(
            join(dir, "small_0"),
            Buffer.concat([header("imgo"), Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9])])
        );
        writeFileSync(join(dir, "full_0"), Buffer.concat([header("imgpsh_fullsize"), PNG]));
        const found = findDiskCacheImage(dir, "0-weu-d1-aabbccddeeff001122334455");
        expect(found?.ext).toBe("png");
        expect(Buffer.from(found?.bytes ?? []).equals(PNG)).toBe(true);
    });
});
