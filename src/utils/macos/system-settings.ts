import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";

const SECURITY_PREFIX = "x-apple.systempreferences:com.apple.preference.security";

/** Every pane goes through here, so this one refusal keeps a test (and a child it spawns) from raising a window. */
function openPane(paneId: string): void {
    refuseHostEffectInTest(`The System Settings pane ${paneId}`, "Assert that the pane would be opened.");
    Bun.spawn(["open", `${SECURITY_PREFIX}?${paneId}`], {
        stdout: "ignore",
        stderr: "ignore",
    });
}

export const settings = {
    openFullDiskAccess: () => openPane("Privacy_AllFiles"),
    openAccessibility: () => openPane("Privacy_Accessibility"),
    openAutomation: () => openPane("Privacy_Automation"),
    openMicrophone: () => openPane("Privacy_Microphone"),
    openCamera: () => openPane("Privacy_Camera"),
    openScreenRecording: () => openPane("Privacy_ScreenCapture"),
} as const;
