import AppKit

/// Opens Clicky's settings in its own `GenesisTools --clicky` process. In Flow, not the Clicky part: the widget opens
/// them too, and a build without Clicky answers the face with the command that adds it (Host/AppParts.swift).
@MainActor
package enum ClickyLaunch {
    package static func openSettings(pageID: String? = nil) {
        guard AppParts.canLaunch(face: "--clicky"), let executable = Bundle.main.executableURL else { return }
        do {
            let child = Process()
            child.executableURL = executable
            child.arguments = ["--clicky"] + (pageID.map { ["--page", $0] } ?? [])
            child.standardInput = FileHandle.nullDevice
            child.standardOutput = FileHandle.nullDevice
            child.standardError = FileHandle.nullDevice
            try child.run()
        } catch {
            NSLog("Clicky launch failed: %@", error.localizedDescription)
            let alert = NSAlert()
            alert.messageText = "Could not open Clicky"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }
}
