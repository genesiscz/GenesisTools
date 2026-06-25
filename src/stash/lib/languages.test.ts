import { describe, expect, test } from "bun:test";
import { commentSyntaxForFile } from "./languages";

describe("commentSyntaxForFile", () => {
    test("ts/tsx/js/jsx/php/java/c/cpp/go/rs/swift → //", () => {
        for (const f of [
            "a.ts",
            "a.tsx",
            "a.js",
            "a.jsx",
            "a.php",
            "a.java",
            "a.c",
            "a.cpp",
            "a.go",
            "a.rs",
            "a.swift",
        ]) {
            expect(commentSyntaxForFile(f).line).toBe("//");
        }
    });
    test("python/ruby/bash/yaml/toml → #", () => {
        for (const f of ["a.py", "a.rb", "a.sh", "a.yaml", "a.yml", "a.toml"]) {
            expect(commentSyntaxForFile(f).line).toBe("#");
        }
    });
    test("html/xml/md → <!-- -->", () => {
        for (const f of ["a.html", "a.xml", "a.md"]) {
            expect(commentSyntaxForFile(f).block).toEqual({ open: "<!--", close: "-->" });
            expect(commentSyntaxForFile(f).line).toBe(null);
        }
    });
    test("css → /* */", () => {
        expect(commentSyntaxForFile("a.css").block).toEqual({ open: "/*", close: "*/" });
    });
    test("unknown extension falls back to //", () => {
        expect(commentSyntaxForFile("a.xyz").line).toBe("//");
    });
});
