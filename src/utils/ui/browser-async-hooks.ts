/**
 * Browser-safe polyfill for node:async_hooks.
 *
 * TanStack Start imports AsyncLocalStorage at the module level even in browser
 * bundles (inside isomorphic function server-callbacks). This polyfill provides
 * a no-op implementation that satisfies the import without crashing the browser.
 *
 * The server callbacks that actually USE the context are never invoked in the
 * browser, so the polyfill never needs to do real context propagation.
 */

export class AsyncLocalStorage<T = unknown> {
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

export class AsyncResource {
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

export function createHook(_hooks: unknown) {
    return { enable: () => {}, disable: () => {} };
}

export function executionAsyncId(): number {
    return 1;
}

export function triggerAsyncId(): number {
    return 0;
}
