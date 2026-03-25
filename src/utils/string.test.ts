import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    escapeShellArg,
    fuzzyFind,
    fuzzyMatch,
    matchGlob,
    removeDiacritics,
    sanitizeOutput,
    slugify,
    stripAnsi,
    truncateText,
} from "./string";

describe("slugify", () => {
    it("replaces spaces and special chars with dashes", () => {
        expect(slugify("Hello World")).toBe("Hello-World");
        expect(slugify("hello@world#test")).toBe("hello-world-test");
    });

    it("removes diacritics", () => {
        expect(slugify("café")).toBe("cafe");
    });

    it("trims leading and trailing dashes", () => {
        expect(slugify("--hello--")).toBe("hello");
        expect(slugify("@hello@")).toBe("hello");
    });

    it("limits to 50 characters", () => {
        expect(slugify("a".repeat(60)).length).toBe(50);
    });

    it("returns empty string for empty input", () => {
        expect(slugify("")).toBe("");
    });

    it("returns empty string for all special chars", () => {
        expect(slugify("@#$%")).toBe("");
    });
});

describe("stripAnsi", () => {
    it("strips color codes", () => {
        expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    });

    it("strips bold/underline codes", () => {
        expect(stripAnsi("\u001b[1mbold\u001b[22m")).toBe("bold");
    });

    it("returns plain string unchanged", () => {
        expect(stripAnsi("hello")).toBe("hello");
    });

    it("handles empty string", () => {
        expect(stripAnsi("")).toBe("");
    });

    it("handles nested codes", () => {
        expect(stripAnsi("\u001b[1m\u001b[31mbold red\u001b[0m")).toBe("bold red");
    });
});

describe("escapeShellArg (Unix)", () => {
    it("wraps in single quotes", () => {
        expect(escapeShellArg("hello")).toBe("'hello'");
    });

    it("escapes single quotes within the string", () => {
        expect(escapeShellArg("it's")).toBe("'it'\"'\"'s'");
    });

    it("handles empty string", () => {
        expect(escapeShellArg("")).toBe("''");
    });

    it("passes through special characters safely inside single quotes", () => {
        expect(escapeShellArg("foo & bar")).toBe("'foo & bar'");
        expect(escapeShellArg("$HOME")).toBe("'$HOME'");
        expect(escapeShellArg("a;b")).toBe("'a;b'");
        expect(escapeShellArg("hello\nworld")).toBe("'hello\nworld'");
    });

    it("handles paths with spaces", () => {
        expect(escapeShellArg("/Users/John Doe/file.txt")).toBe("'/Users/John Doe/file.txt'");
    });

    it("handles glob patterns", () => {
        expect(escapeShellArg("*.ts")).toBe("'*.ts'");
        expect(escapeShellArg("src/**/*.tsx")).toBe("'src/**/*.tsx'");
    });
});

describe("escapeShellArg (Windows — cross-spawn compatible)", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    });

    afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    // Phase 1: CommandLineToArgvW quoting
    it("wraps in ^-escaped double quotes", () => {
        expect(escapeShellArg("hello")).toBe('^"hello^"');
    });

    it("handles empty string", () => {
        expect(escapeShellArg("")).toBe('^"^"');
    });

    it("escapes double quotes for CommandLineToArgvW", () => {
        expect(escapeShellArg('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
    });

    it("doubles trailing backslashes to prevent escaping the closing quote", () => {
        expect(escapeShellArg("C:\\path\\")).toBe('^"C:\\path\\\\^"');
    });

    it("doubles backslashes that immediately precede a double quote", () => {
        expect(escapeShellArg('a\\"b')).toBe('^"a\\\\\\^"b^"');
    });

    it("leaves mid-string backslashes alone when not before a quote", () => {
        expect(escapeShellArg("C:\\Users\\Martin")).toBe('^"C:\\Users\\Martin^"');
    });

    // Phase 2: cmd.exe metacharacter escaping
    it("escapes % with ^ to prevent cmd.exe variable expansion", () => {
        expect(escapeShellArg("100%")).toBe('^"100^%^"');
        expect(escapeShellArg("%PATH%")).toBe('^"^%PATH^%^"');
    });

    it("escapes & and | to prevent command chaining", () => {
        expect(escapeShellArg("foo & bar")).toBe('^"foo^ ^&^ bar^"');
        expect(escapeShellArg("foo | bar")).toBe('^"foo^ ^|^ bar^"');
    });

    it("handles paths with spaces (space is ^-escaped)", () => {
        expect(escapeShellArg("C:\\Program Files\\app")).toBe('^"C:\\Program^ Files\\app^"');
    });

    it("escapes glob metacharacters * and ?", () => {
        expect(escapeShellArg("*.ts")).toBe('^"^*.ts^"');
        expect(escapeShellArg("src\\**\\*.tsx")).toBe('^"src\\^*^*\\^*.tsx^"');
    });
});

describe("removeDiacritics", () => {
    it("removes accented characters", () => {
        expect(removeDiacritics("café")).toBe("cafe");
        expect(removeDiacritics("éèê")).toBe("eee");
    });

    it("returns plain strings unchanged", () => {
        expect(removeDiacritics("hello")).toBe("hello");
    });

    it("passes through non-latin characters", () => {
        expect(removeDiacritics("你好")).toBe("你好");
    });

    it("handles empty string", () => {
        expect(removeDiacritics("")).toBe("");
    });
});

describe("truncateText", () => {
    it("returns text unchanged when within limit", () => {
        expect(truncateText("hello", 10)).toBe("hello");
    });

    it("truncates with ellipsis when exceeding limit", () => {
        expect(truncateText("hello world", 8)).toBe("hello...");
    });

    it("returns exact-length text unchanged", () => {
        expect(truncateText("hello", 5)).toBe("hello");
    });

    it("handles maxLength <= 3 without ellipsis", () => {
        expect(truncateText("hello", 3)).toBe("hel");
        expect(truncateText("hello", 1)).toBe("h");
    });

    it("uses default maxLength of 100", () => {
        const text = "a".repeat(101);
        expect(truncateText(text)).toBe(`${"a".repeat(97)}...`);
    });

    it("handles empty string", () => {
        expect(truncateText("", 10)).toBe("");
    });
});

describe("sanitizeOutput", () => {
    it("removes control characters", () => {
        expect(sanitizeOutput("hello\u0000world")).toBe("helloworld");
        expect(sanitizeOutput("tab\there")).toBe("tabhere");
    });

    it("strips ANSI codes when removeANSI is true", () => {
        expect(sanitizeOutput("\u001b[31mred\u001b[0m", true)).toBe("red");
    });

    it("handles empty string", () => {
        expect(sanitizeOutput("")).toBe("");
    });
});

describe("matchGlob", () => {
    it("matches exact string", () => {
        expect(matchGlob("hello", "hello")).toBe(true);
    });

    it("matches with wildcard", () => {
        expect(matchGlob("hello world", "hello*")).toBe(true);
        expect(matchGlob("hello world", "*world")).toBe(true);
        expect(matchGlob("hello world", "*lo wo*")).toBe(true);
    });

    it("is case insensitive", () => {
        expect(matchGlob("Hello", "hello")).toBe(true);
    });

    it("handles special regex characters in pattern", () => {
        expect(matchGlob("file.ts", "file.ts")).toBe(true);
        expect(matchGlob("file(1).ts", "file(1).ts")).toBe(true);
    });

    it("returns false for non-matching", () => {
        expect(matchGlob("hello", "world")).toBe(false);
    });
});

describe("fuzzyMatch", () => {
    it("returns 0 for exact match (case insensitive)", () => {
        expect(fuzzyMatch("hello", "hello")).toBe(0);
        expect(fuzzyMatch("Hello", "hello")).toBe(0);
    });

    it("returns 1 for startsWith match", () => {
        expect(fuzzyMatch("hel", "hello")).toBe(1);
    });

    it("returns 2 for includes match", () => {
        expect(fuzzyMatch("ell", "hello")).toBe(2);
    });

    it("returns 3+ for subsequence match with gaps", () => {
        expect(fuzzyMatch("hlo", "hello")).toBeGreaterThanOrEqual(3);
    });

    it("returns -1 for no match", () => {
        expect(fuzzyMatch("xyz", "hello")).toBe(-1);
    });
});

describe("fuzzyFind", () => {
    it("returns best match", () => {
        expect(fuzzyFind("hel", ["world", "hello", "help"])).toBe("hello");
    });

    it("returns null when no match", () => {
        expect(fuzzyFind("xyz", ["hello", "world"])).toBeNull();
    });

    it("returns null for empty candidates", () => {
        expect(fuzzyFind("hello", [])).toBeNull();
    });

    it("prefers exact match over partial", () => {
        expect(fuzzyFind("hello", ["hello world", "hello"])).toBe("hello");
    });
});
