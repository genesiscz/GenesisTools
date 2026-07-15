import { describe, expect, test } from "bun:test";
import { classFromContentType, classifyBodyPeek } from "./probe";

describe("classFromContentType", () => {
    test("html / json / text", () => {
        expect(classFromContentType("text/html; charset=utf-8")).toBe("html");
        expect(classFromContentType("application/json")).toBe("json");
        expect(classFromContentType("text/plain")).toBe("text");
        expect(classFromContentType("application/octet-stream")).toBeNull();
    });
});

describe("classifyBodyPeek", () => {
    test("sniffs html and json", () => {
        expect(classifyBodyPeek("<!DOCTYPE html><html>")).toBe("html");
        expect(classifyBodyPeek('{"ok":true}')).toBe("json");
        expect(classifyBodyPeek("hello world")).toBe("text");
    });
});
