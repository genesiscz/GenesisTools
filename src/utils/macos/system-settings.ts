const SECURITY_PREFIX = "x-apple.systempreferences:com.apple.preference.security";

function openPane(paneId: string): void {
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
