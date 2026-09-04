import { describe, expect, test } from "bun:test";
import { isTeamsAppRunning } from "./process";

describe("isTeamsAppRunning", () => {
    test("audio driver alone is not the app", () => {
        const out = "613 Core Audio Driver (MSTeamsAudioDevice.driver)\n825 TeamsWidgetExtension -AppleLanguages";
        expect(isTeamsAppRunning(out)).toBe(false);
    });

    test("MacOS/MSTeams is the app", () => {
        const out = [
            "613 Core Audio Driver (MSTeamsAudioDevice.driver)",
            "27624 /Applications/Microsoft Teams.app/Contents/MacOS/MSTeams",
        ].join("\n");
        expect(isTeamsAppRunning(out)).toBe(true);
    });

    test("WebView helper counts as up", () => {
        expect(
            isTeamsAppRunning(
                "27662 /Applications/Microsoft Teams.app/Contents/Helpers/Microsoft Teams WebView.app/Contents/MacOS/Microsoft Teams WebView --embedded-browser-webview=1"
            )
        ).toBe(true);
    });

    test("respawn helper counts as up", () => {
        expect(
            isTeamsAppRunning(
                "27657 /Applications/Microsoft Teams.app/Contents/Helpers/com.microsoft.teams2.respawn 27624"
            )
        ).toBe(true);
    });

    test("orphan crashpad helper is not the app", () => {
        const out =
            "4242 /Applications/Microsoft Teams.app/Contents/Helpers/Microsoft Teams WebView.app/Contents/Frameworks/Microsoft Edge Framework.framework/Versions/148.0.3967.83/Helpers/msedgewebview2_crashpad_handler --database=/Users/work/Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/EBWebView/Crashpad";
        expect(isTeamsAppRunning(out)).toBe(false);
    });
});
