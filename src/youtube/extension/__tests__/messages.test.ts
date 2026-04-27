import { describe, expect, it } from "bun:test";
import type { ExtensionRequest } from "@ext/shared/messages";

const requestTypes: ExtensionRequest["type"][] = [
    "config:get",
    "config:set",
    "api:listChannels",
    "api:addChannel",
    "api:getVideo",
    "api:getTranscript",
    "api:getSummary",
    "api:askVideo",
    "api:startPipeline",
    "api:getJob",
];

describe("extension message contract", () => {
    it("covers the v1 background request surface", () => {
        expect(requestTypes).toEqual([
            "config:get",
            "config:set",
            "api:listChannels",
            "api:addChannel",
            "api:getVideo",
            "api:getTranscript",
            "api:getSummary",
            "api:askVideo",
            "api:startPipeline",
            "api:getJob",
        ]);
    });
});
