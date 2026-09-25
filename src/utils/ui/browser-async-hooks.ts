/**
 * Browser-safe polyfill for node:async_hooks.
 *
 * TanStack Start imports AsyncLocalStorage at the module level even in browser
 * bundles (inside isomorphic function server-callbacks). This polyfill provides
 * a no-op implementation that satisfies the import without crashing the browser.
 *
 * The server callbacks that actually USE the context are never invoked in the
 * browser, so the polyfill never needs to do real context propagation.
 *
 * The alias is global, so SSR resolves here too: TanStack Start marks its own
 * packages noExternal, which inlines `@tanstack/start-storage-context` and routes
 * its `node:async_hooks` import through the alias. The no-op store drops the
 * request context after the first `await`, and a server function called from an
 * SSR loader then fails with "No Start context found in AsyncLocalStorage". So
 * every export defers to the real module when the runtime has one.
 */

class BrowserAsyncLocalStorage<T = unknown> {
    private _store: T | undefined = undefined;

    run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
        const prev = this._store;
        this._store = store;
        try {
            return callback(...args);
        } finally {
            this._store = prev;
        }
    }

    getStore(): T | undefined {
        return this._store;
    }

    enterWith(store: T): void {
        this._store = store;
    }

    exit<R>(callback: (...args: unknown[]) => R, ...args: unknown[]): R {
        const prev = this._store;
        this._store = undefined;
        try {
            return callback(...args);
        } finally {
            this._store = prev;
        }
    }

    disable(): void {}

    static bind<T extends (...args: unknown[]) => unknown>(fn: T): T {
        return fn;
    }

    static snapshot(): () => void {
        return () => {};
    }
}

class BrowserAsyncResource {
    static bind<T extends (...args: unknown[]) => unknown>(fn: T): T {
        return fn;
    }

    bind<T extends (...args: unknown[]) => unknown>(fn: T): T {
        return fn;
    }

    emitDestroy(): this {
        return this;
    }

    runInAsyncScope<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R {
        return fn(...args);
    }
}

function browserCreateHook(_hooks: unknown) {
    return { enable: () => {}, disable: () => {} };
}

function browserExecutionAsyncId(): number {
    return 1;
}

function browserTriggerAsyncId(): number {
    return 0;
}

const nativeAsyncHooks = typeof process === "undefined" ? undefined : process.getBuiltinModule?.("node:async_hooks");

export const AsyncLocalStorage = nativeAsyncHooks?.AsyncLocalStorage ?? BrowserAsyncLocalStorage;
export const AsyncResource = nativeAsyncHooks?.AsyncResource ?? BrowserAsyncResource;
export const createHook = nativeAsyncHooks?.createHook ?? browserCreateHook;
export const executionAsyncId = nativeAsyncHooks?.executionAsyncId ?? browserExecutionAsyncId;
export const triggerAsyncId = nativeAsyncHooks?.triggerAsyncId ?? browserTriggerAsyncId;
