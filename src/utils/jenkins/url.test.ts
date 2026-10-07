import { describe, expect, it } from "bun:test";
import { normalizeBaseUrl } from "./url";

describe("normalizeBaseUrl", () => {
    const root = "https://jenkins.example.com";

    it("keeps the root of any pasted Jenkins page", () => {
        expect(normalizeBaseUrl(`${root}/user/`)).toBe(root);
        expect(normalizeBaseUrl(`${root}/user/someone/configure`)).toBe(root);
        expect(normalizeBaseUrl(`${root}/me/security/`)).toBe(root);
        expect(normalizeBaseUrl(`${root}/job/Team/job/app/job/release/`)).toBe(root);
        expect(normalizeBaseUrl(`${root}/login?from=%2F`)).toBe(root);
        expect(normalizeBaseUrl(`${root}/?foo=1#bar`)).toBe(root);
    });

    it("adds https, drops trailing slashes and surrounding whitespace", () => {
        expect(normalizeBaseUrl("jenkins.example.com/")).toBe(root);
        expect(normalizeBaseUrl(`  ${root}//  `)).toBe(root);
    });

    it("keeps http, a port and a path prefix", () => {
        expect(normalizeBaseUrl("http://localhost:8080/job/x/12/")).toBe("http://localhost:8080");
        expect(normalizeBaseUrl("https://ci.example.com/jenkins/user/x")).toBe("https://ci.example.com/jenkins");
        expect(normalizeBaseUrl("https://ci.example.com/jenkins/")).toBe("https://ci.example.com/jenkins");
    });

    it("does not read a host named like a Jenkins page as a page", () => {
        expect(normalizeBaseUrl("https://me/")).toBe("https://me");
        expect(normalizeBaseUrl("https://job.example.com/job/x")).toBe("https://job.example.com");
    });

    it("returns something printable for input that is not a URL", () => {
        expect(normalizeBaseUrl("not a url/")).toBe("https://not a url");
    });
});
