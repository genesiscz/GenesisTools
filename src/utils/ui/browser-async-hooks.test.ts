import { expect, test } from "bun:test";
import * as nativeAsyncHooks from "node:async_hooks";
import { AsyncLocalStorage, AsyncResource } from "./browser-async-hooks";

// The no-op store drops TanStack Start's request context after the first await, so SSR must get the real one.
test("on a server runtime the polyfill hands out the real async_hooks classes", () => {
    expect(AsyncLocalStorage).toBe(nativeAsyncHooks.AsyncLocalStorage);
    expect(AsyncResource).toBe(nativeAsyncHooks.AsyncResource);
});
