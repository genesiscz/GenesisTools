import type { ContainerInfo } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { DASH, partitionByState, runState, shortImage } from "@/features/containers/units";

function container(overrides: Partial<ContainerInfo>): ContainerInfo {
    return { id: "1", name: "c", image: "img", state: "running", status: "Up", ports: "", ...overrides };
}

describe("containers units — runState", () => {
    it("treats only lowercase 'running' as running, everything else as stopped", () => {
        expect(runState({ state: "running" })).toBe("running");
        expect(runState({ state: "Running" })).toBe("running");
        expect(runState({ state: "exited" })).toBe("stopped");
        expect(runState({ state: "created" })).toBe("stopped");
        expect(runState({ state: "paused" })).toBe("stopped");
    });
});

describe("containers units — partitionByState", () => {
    it("splits into running/stopped preserving order within each group", () => {
        const list = [
            container({ id: "a", state: "running" }),
            container({ id: "b", state: "exited" }),
            container({ id: "c", state: "running" }),
        ];

        const { running, stopped } = partitionByState(list);
        expect(running.map((x) => x.id)).toEqual(["a", "c"]);
        expect(stopped.map((x) => x.id)).toEqual(["b"]);
    });
});

describe("containers units — shortImage", () => {
    it("trims registry host and digest, em-dash on empty", () => {
        expect(shortImage("postgres:16")).toBe("postgres:16");
        expect(shortImage("ghcr.io/acme/api:latest")).toBe("api:latest");
        expect(shortImage("redis@sha256:deadbeef")).toBe("redis");
        expect(shortImage("")).toBe(DASH);
    });
});
