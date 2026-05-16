import { describe, expect, test } from "bun:test";
import { parseDockerPsJsonl } from "./docker";

const FIXTURE = [
    '{"ID":"abc123","Names":"pg","Image":"postgres:16","State":"running","Status":"Up 3 hours","Ports":"0.0.0.0:5432->5432/tcp"}',
    '{"ID":"def456","Names":"old-job","Image":"alpine:3.20","State":"exited","Status":"Exited (0) 2 days ago","Ports":""}',
    '{"ID":"ghi789","Names":"fresh","Image":"redis:7","State":"created","Status":"Created"}',
    "",
].join("\n");

describe("parseDockerPsJsonl", () => {
    test("parses 3 containers and skips blank trailing line", () => {
        const result = parseDockerPsJsonl(FIXTURE);

        expect(result).toHaveLength(3);

        expect(result[0]).toEqual({
            id: "abc123",
            name: "pg",
            image: "postgres:16",
            state: "running",
            status: "Up 3 hours",
            ports: "0.0.0.0:5432->5432/tcp",
        });

        expect(result[1]).toEqual({
            id: "def456",
            name: "old-job",
            image: "alpine:3.20",
            state: "exited",
            status: "Exited (0) 2 days ago",
            ports: "",
        });

        expect(result[2]).toEqual({
            id: "ghi789",
            name: "fresh",
            image: "redis:7",
            state: "created",
            status: "Created",
            ports: "",
        });
    });

    test("lowercases state", () => {
        const result = parseDockerPsJsonl(
            '{"ID":"x","Names":"n","Image":"i","State":"RUNNING","Status":"Up","Ports":""}'
        );

        expect(result[0]?.state).toBe("running");
    });

    test("empty string returns empty array", () => {
        expect(parseDockerPsJsonl("")).toEqual([]);
    });
});
