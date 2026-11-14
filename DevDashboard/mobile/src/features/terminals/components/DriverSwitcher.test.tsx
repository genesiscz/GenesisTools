import { afterEach, expect, it, mock } from "bun:test";
import { createElement, forwardRef } from "react";
import type { TerminalDriverProps } from "@/features/terminals/registry";
import type { TerminalRenderer } from "@/features/terminals/TerminalRenderer";

// Bun cannot parse React Native's Flow entry point; retain props and children on host nodes.
mock.module("react-native", () => ({
    View: "View",
    Text: "Text",
    Pressable: "View",
    StyleSheet: { flatten: (style: unknown) => style ?? {} },
}));
mock.module("@/theme/colors", () => ({ useThemeColors: () => ({}) }));
mock.module("@/state/connection-store", () => ({ useTierCapabilities: () => ({ plainUrls: false }) }));
mock.module("@/features/terminals/driver-store", () => ({
    useDriverStore: (select: (state: { driver: string; setDriver: () => void }) => unknown) =>
        select({ driver: "webview-html", setDriver: () => undefined }),
}));

const { cleanup, render } = await import("@testing-library/react-native/pure");
const { registerDriver } = await import("@/features/terminals/registry");
const { DriverSwitcher } = await import("@/features/terminals/components/DriverSwitcher");

const component = forwardRef<TerminalRenderer, TerminalDriverProps>(() => null);
registerDriver({ id: "webview-ttyd", label: "Plain page", blurb: "Loads ttyd", needsPlainUrls: true, component });
registerDriver({ id: "webview-html", label: "Bundled page", blurb: "Runs anywhere", needsPlainUrls: false, component });

afterEach(cleanup);

it("names each driver by its label, and an unavailable one with the reason, never by its internal id", async () => {
    const screen = await render(createElement(DriverSwitcher));
    const plain = screen.getByTestId("driver-option-webview-ttyd");
    const bundled = screen.getByTestId("driver-option-webview-html");

    expect(plain.props.accessibilityLabel).toBe(
        "Plain page. Not on this connection: it cannot load the Mac's pages by plain URL."
    );
    expect(plain.props.accessibilityState).toEqual({ selected: false, disabled: true });
    expect(bundled.props.accessibilityLabel).toBe("Bundled page");
    expect(bundled.props.accessibilityHint).toBe("Runs anywhere");
});
