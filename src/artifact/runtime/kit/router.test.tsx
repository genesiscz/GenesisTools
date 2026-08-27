import { afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { currentPath, detectBase } from "./router";

/**
 * The Router's compatibility promise is that ONE artifact routes correctly
 * standalone, under a library mount, and as hash routing from a built file://
 * page. detectBase/currentPath are the whole of that contract, and they read
 * `window` directly, so each mode gets its own window.
 */
function useLocation(url: string, injectedBase?: string): void {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url });

    if (injectedBase !== undefined) {
        (dom.window as unknown as { __ARTIFACT_BASE__?: string }).__ARTIFACT_BASE__ = injectedBase;
    }

    Object.assign(globalThis, { window: dom.window, document: dom.window.document });
}

afterEach(() => {
    Object.assign(globalThis, { window: undefined, document: undefined });
});

describe("detectBase", () => {
    test("uses the base the tsx shell injected, without a trailing slash", () => {
        useLocation("http://localhost:3076/__tsx/app.tsx/item/42", "/a/notes/__tsx/app.tsx/");
        expect(detectBase()).toBe("/a/notes/__tsx/app.tsx");
    });

    test("falls back to the pathname up to the artifact file, standalone", () => {
        useLocation("http://localhost:3076/__tsx/app.tsx/item/42");
        expect(detectBase()).toBe("/__tsx/app.tsx");
    });

    test("falls back the same way under a library mount", () => {
        useLocation("http://localhost:3076/a/notes/__tsx/app.tsx/item/42");
        expect(detectBase()).toBe("/a/notes/__tsx/app.tsx");
    });

    test("is empty for a clean URL with no artifact file segment", () => {
        useLocation("http://localhost:3076/demo/item/42");
        expect(detectBase()).toBe("");
    });
});

describe("currentPath", () => {
    test("strips the base prefix, standalone", () => {
        useLocation("http://localhost:3076/__tsx/app.tsx/item/42");
        expect(currentPath("/__tsx/app.tsx")).toBe("/item/42");
    });

    test("strips the mount prefix under the library", () => {
        useLocation("http://localhost:3076/a/notes/__tsx/app.tsx/item/42");
        expect(currentPath("/a/notes/__tsx/app.tsx")).toBe("/item/42");
    });

    test("the artifact root is / and never an empty path", () => {
        useLocation("http://localhost:3076/__tsx/app.tsx");
        expect(currentPath("/__tsx/app.tsx")).toBe("/");
    });

    test("keeps the raw encoding so per-segment decoding stays correct", () => {
        useLocation("http://localhost:3076/demo/item/a%2Fb");
        expect(currentPath("/demo")).toBe("/item/a%2Fb");
    });

    test("a built file:// page routes from the HASH, deep link included", () => {
        useLocation("file:///Users/x/dist/app.html#/item/42");
        expect(currentPath("/dist/app.html")).toBe("/item/42");
    });

    test("a file:// page with no hash is the artifact root", () => {
        useLocation("file:///Users/x/dist/app.html");
        expect(currentPath("/dist/app.html")).toBe("/");
    });
});
