import { afterEach, expect, spyOn, test } from "bun:test";
import { out } from "@genesiscz/utils/logger";
import { appNeedFixture } from "@genesiscz/utils/macos/testing/app-need";
import { printAppUnavailable, printNotificationFallbackStatus, printNotificationRpcFailure } from "./index";

const methodUnknown = { ok: false as const, error: { code: "method_unknown", message: "unknown method" } };
const previousExit = process.exitCode;
afterEach(() => {
    process.exitCode = previousExit;
});

test("notify status leaves unknown methods unprobed and preserves the JSON failure and fallback", async () => {
    const env = { ...appNeedFixture({ methods: null }), fresh: true, write: true };
    const fallback = { kind: "osascript-only" as const };
    const info = spyOn(out, "info").mockImplementation(() => {});
    const error = spyOn(out, "error").mockImplementation(() => {});
    const json = spyOn(out, "result").mockImplementation(() => {});
    try {
        await printNotificationFallbackStatus(methodUnknown, false, fallback, env);
        const lines = info.mock.calls.flat().join("\n");
        expect(lines).toContain("not known whether the installed build answers notify.status");
        expect(lines).not.toContain("fixture-build");
        expect(env.state.read().areas).toEqual({});
        info.mockClear();
        error.mockClear();
        await printNotificationFallbackStatus(methodUnknown, true, fallback, env);
        expect(json).toHaveBeenCalledWith({ ...methodUnknown, fallback });
        expect(info).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    } finally {
        json.mockRestore();
        error.mockRestore();
        info.mockRestore();
    }
});

test("notify status keeps the fallback backend and prints only the failed status need's hint", async () => {
    const info = spyOn(out, "info").mockImplementation(() => {});
    const error = spyOn(out, "error").mockImplementation(() => {});
    try {
        const fallback = { kind: "terminal-notifier" as const, path: "/fixture/notifier" };
        await printNotificationFallbackStatus(methodUnknown, false, fallback, appNeedFixture({ installed: false }));
        expect(error).toHaveBeenCalledWith("Using terminal-notifier at /fixture/notifier (not confirmed authorized).");
        expect(info).toHaveBeenCalledWith(
            "GenesisTools.app is not installed at /fixture/GenesisTools.app. Run `fixture-build`."
        );
        info.mockClear();
        await printNotificationFallbackStatus(
            methodUnknown,
            false,
            { kind: "genesis-app" },
            appNeedFixture({ methods: ["notify.status"] })
        );
        expect(info).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith("method_unknown: unknown method");
    } finally {
        error.mockRestore();
        info.mockRestore();
    }
});

test("notify authorize and settings explain a missing method and keep an answered need quiet", async () => {
    const info = spyOn(out, "info").mockImplementation(() => {});
    const error = spyOn(out, "error").mockImplementation(() => {});
    try {
        for (const method of ["notify.authorize", "notify.settings"] as const) {
            await printNotificationRpcFailure(method, methodUnknown, false, appNeedFixture());
            expect(info).toHaveBeenCalledWith(`the installed build does not answer ${method}. Run \`fixture-build\`.`);
            info.mockClear();
            await printNotificationRpcFailure(method, methodUnknown, false, appNeedFixture({ methods: [method] }));
            expect(info).not.toHaveBeenCalled();
        }
    } finally {
        error.mockRestore();
        info.mockRestore();
    }
});

test("notify list and remove give a method-specific fix only when their need fails", async () => {
    const error = spyOn(out, "error").mockImplementation(() => {});
    try {
        for (const method of ["notify.list", "notify.remove"] as const) {
            await printAppUnavailable(method, appNeedFixture());
            expect(error).toHaveBeenCalledWith(`the installed build does not answer ${method}. Run \`fixture-build\`.`);
            error.mockClear();
            await printAppUnavailable(method, appNeedFixture({ methods: [method] }));
            expect(error).toHaveBeenCalledWith(`GenesisTools.app could not ${method.slice(7)} notifications.`);
        }
    } finally {
        error.mockRestore();
    }
});
