import { describe, expect, it } from "bun:test";
import {
    decodeE2eRequest,
    decodeE2eResponse,
    type E2eRequest,
    type E2eResponse,
    encodeE2eRequest,
    encodeE2eResponse,
} from "@app/dev-dashboard/contract/e2e-request";

describe("E2eRequest codec", () => {
    it("round-trips a GET", () => {
        const req: E2eRequest = { method: "GET", path: "/api/system/pulse" };

        expect(decodeE2eRequest(encodeE2eRequest(req))).toEqual(req);
    });

    it("round-trips a POST with a body", () => {
        const req: E2eRequest = { method: "POST", path: "/api/qa/read", body: '{"ids":["a"]}' };

        expect(decodeE2eRequest(encodeE2eRequest(req))).toEqual(req);
    });

    it("throws on a malformed request", () => {
        expect(() => decodeE2eRequest('{"path":"/x"}')).toThrow(/invalid/);
    });
});

describe("E2eResponse codec", () => {
    it("round-trips", () => {
        const res: E2eResponse = { status: 200, body: '{"ok":true}', contentType: "application/json" };

        expect(decodeE2eResponse(encodeE2eResponse(res))).toEqual(res);
    });

    it("throws on a malformed response", () => {
        expect(() => decodeE2eResponse('{"status":"200"}')).toThrow(/invalid/);
    });
});
