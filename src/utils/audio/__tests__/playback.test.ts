import { describe, expect, test } from "bun:test";
import { isFfplayAvailable, playBuffer, playStream } from "@app/utils/audio/playback";

describe("playback", () => {
    test("isFfplayAvailable returns boolean", () => {
        expect(typeof isFfplayAvailable()).toBe("boolean");
    });

    test("playBuffer with empty buffer resolves cleanly (smoke)", async () => {
        // ffplay/afplay both exit fast on a 0-byte file; assert no throw.
        const empty = Buffer.alloc(0);
        await expect(playBuffer(empty, "audio/mpeg", { volume: 0, wait: true })).resolves.toBeUndefined();
    });

    test("playStream consumes an empty async iterable", async () => {
        const empty = (async function* () {
            yield* [];
        })();
        await expect(
            playStream(empty as AsyncIterable<Uint8Array>, "audio/mpeg", { volume: 0, wait: true })
        ).resolves.toBeUndefined();
    });
});
