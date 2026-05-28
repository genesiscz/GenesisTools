import { afterAll, beforeAll, expect, test } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { setupTaskIntegrationHome } from "./task-integration-env";

const env = setupTaskIntegrationHome();
const FIXTURE = `json-test-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(() => {
    env.task(["run", "--session", FIXTURE, "--no-tty", "--", "bash", "-c", "echo hi"]);
});

afterAll(() => {
    env.clean(FIXTURE);
});

test("tools task sessions --json emits parseable JSON array (F4)", () => {
    const r = env.task(["sessions", "--json"]);
    expect(r.code).toBe(0);
    const parsed = SafeJSON.parse(r.stdout, { strict: true });
    expect(Array.isArray(parsed)).toBe(true);
    const fixture = (parsed as Array<{ name: string }>).find((s) => s.name === FIXTURE);
    expect(fixture).toBeDefined();
    expect(fixture).toHaveProperty("state");
    expect(fixture).toHaveProperty("jsonlSizeBytes");
    expect(fixture).toHaveProperty("lastSeq");
});
