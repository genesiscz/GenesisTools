import { describe, expect, it } from "vitest";
import { resolveWorldConfig } from "./world";

describe("resolveWorldConfig", () => {
  it("defaults to the local world with no env", () => {
    expect(resolveWorldConfig({})).toEqual({ kind: "local", world: undefined, queueNamespace: undefined });
  });

  it("selects the postgres world when EVE_WORLD=postgres and a URL is present", () => {
    expect(
      resolveWorldConfig({ EVE_WORLD: "postgres", WORKFLOW_POSTGRES_URL: "postgres://x" })
    ).toEqual({ kind: "postgres", world: "@workflow/world-postgres", queueNamespace: "genesis-eve" });
  });

  it("honors an explicit queue namespace", () => {
    expect(
      resolveWorldConfig({ EVE_WORLD: "postgres", WORKFLOW_POSTGRES_URL: "postgres://x", WORKFLOW_QUEUE_NAMESPACE: "custom" }).queueNamespace
    ).toBe("custom");
  });

  it("throws when postgres is selected without a URL", () => {
    expect(() => resolveWorldConfig({ EVE_WORLD: "postgres" })).toThrow(/requires WORKFLOW_POSTGRES_URL/);
  });

  it("throws on an unknown world kind", () => {
    expect(() => resolveWorldConfig({ EVE_WORLD: "mysql" })).toThrow(/Unknown EVE_WORLD/);
  });
});
