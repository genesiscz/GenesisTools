import { afterEach, describe, expect, it } from "vitest";
import { UnauthenticatedError } from "eve/channels/auth";
import { parseServiceKeys, resolveServiceKeys, serviceKeyAuth, tokenMatchesAny } from "./service-key-auth";

function makeRequest(auth?: string): Request {
  const headers = new Headers();

  if (auth) {
    headers.set("Authorization", auth);
  }

  return new Request("http://127.0.0.1:2000/eve/v1/session", { headers });
}

const originalKey = process.env.EVE_SERVICE_KEY;

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.EVE_SERVICE_KEY;
  } else {
    process.env.EVE_SERVICE_KEY = originalKey;
  }
});

describe("parseServiceKeys", () => {
  it("returns an empty list when unset", () => {
    expect(parseServiceKeys(undefined)).toEqual([]);
    expect(parseServiceKeys("")).toEqual([]);
  });

  it("splits a comma-separated list and trims blanks", () => {
    expect(parseServiceKeys("alice-key, bob-key ,, carol-key")).toEqual(["alice-key", "bob-key", "carol-key"]);
  });
});

describe("resolveServiceKeys — fail closed on garbage", () => {
  it("keeps open mode when the value is unset (localhost dev)", () => {
    expect(resolveServiceKeys(undefined)).toEqual([]);
  });

  it("returns the parsed keys for a valid list", () => {
    expect(resolveServiceKeys("k1,k2")).toEqual(["k1", "k2"]);
  });

  it("throws for a commas-only value instead of silently opening every route", () => {
    expect(() => resolveServiceKeys(",,,")).toThrow(/no valid service keys/);
  });

  it("throws for a value that is all separators and whitespace", () => {
    expect(() => resolveServiceKeys(", ,\t,")).toThrow(/no valid service keys/);
  });
});

describe("tokenMatchesAny — hash-normalized timing-safe compare", () => {
  it("matches a correct key and rejects a wrong one", () => {
    expect(tokenMatchesAny("secret", ["secret"])).toBe(true);
    expect(tokenMatchesAny("nope", ["secret"])).toBe(false);
  });

  it("accepts any key from the per-user list", () => {
    const keys = ["alice-key", "bob-key"];
    expect(tokenMatchesAny("alice-key", keys)).toBe(true);
    expect(tokenMatchesAny("bob-key", keys)).toBe(true);
    expect(tokenMatchesAny("carol-key", keys)).toBe(false);
  });

  it("matches keys of differing lengths", () => {
    const keys = ["short", "a-much-longer-service-key-value-0123456789"];
    expect(tokenMatchesAny("short", keys)).toBe(true);
    expect(tokenMatchesAny("a-much-longer-service-key-value-0123456789", keys)).toBe(true);
    expect(tokenMatchesAny("a-much-longer", keys)).toBe(false);
  });
});

describe("serviceKeyAuth — eve route-auth walk entry", () => {
  it("stays open (accepts every request) when no keys are configured", () => {
    delete process.env.EVE_SERVICE_KEY;
    const auth = serviceKeyAuth();
    const ctx = auth(makeRequest());
    expect(ctx).toBeTruthy();
    expect((ctx as { principalType: string }).principalType).toBe("anonymous");
  });

  it("accepts a valid Bearer key and tags a service principal", () => {
    process.env.EVE_SERVICE_KEY = "k1,k2";
    const auth = serviceKeyAuth();
    for (const key of ["k1", "k2"]) {
      const ctx = auth(makeRequest(`Bearer ${key}`));
      expect((ctx as { principalType: string }).principalType).toBe("service");
    }
  });

  it("throws a 401 UnauthenticatedError when the key is missing", () => {
    process.env.EVE_SERVICE_KEY = "k1,k2";
    const auth = serviceKeyAuth();
    try {
      auth(makeRequest());
      throw new Error("expected serviceKeyAuth to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthenticatedError);
      expect((err as UnauthenticatedError).response.status).toBe(401);
    }
  });

  it("throws a 401 UnauthenticatedError when the key is wrong", () => {
    process.env.EVE_SERVICE_KEY = "k1,k2";
    const auth = serviceKeyAuth();
    expect(() => auth(makeRequest("Bearer nope"))).toThrow(UnauthenticatedError);
  });

  it("fails closed at construction when EVE_SERVICE_KEY is all commas", () => {
    process.env.EVE_SERVICE_KEY = ",,,";
    expect(() => serviceKeyAuth()).toThrow(/no valid service keys/);
  });
});
