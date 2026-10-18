import AppKit

/// Opens the feature settings window in its own `GenesisTools --features` process (Parts/Features). In the host, not a
/// part: the hub and the widget open it, and a build without the features part answers with the command that adds it
/// (AppParts.swift).
@MainActor
package enum FeatureSettingsLaunch {
    package static let face = "--features"

    package static func open(pageID: String? = nil) {
        guard AppParts.canLaunch(face: face), let executable = Bundle.main.executableURL else { return }
        do {
            let child = Process()
            child.executableURL = executable
            child.arguments = [face] + (pageID.map { ["--page", $0] } ?? [])
            child.standardInput = FileHandle.nullDevice
            child.standardOutput = FileHandle.nullDevice
            child.standardError = FileHandle.nullDevice
            try child.run()
        } catch {
            NSLog("Settings launch failed: %@", error.localizedDescription)
            let alert = NSAlert()
            alert.messageText = "Could not open Settings"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }
}
