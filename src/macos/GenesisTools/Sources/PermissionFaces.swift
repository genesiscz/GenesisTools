// Permission faces of GenesisTools.app:
//   GenesisTools --permission-status <kind>                  print what macOS reports for the grant, then exit
//   GenesisTools --permission-dialog <kind> [--reason <text>] show the GenesisKit permission dialog, exit when it closes
//
// --permission-status is the fresh-process probe: macOS caches Input Monitoring and Screen Recording per process, so
// a running face asks a new one whether a grant given since its launch exists (GenesisKitHostAdapter). It reads the
// real grant, never the denial simulation; the simulation answers for itself (PermissionCenter.freshStatus).
// --permission-dialog lets a face with no window (--mic, a `tools` run) put the dialog on screen.

import AppKit
import Foundation

private func permissionUsage() -> Never {
    let kinds = PermissionKind.allCases.map(\.rawValue).joined(separator: ", ")
    FileHandle.standardError.write(Data("""
    usage: GenesisTools --permission-status <kind>
           GenesisTools --permission-dialog <kind> [--reason <text>]
      kinds: \(kinds)

    """.utf8))
    exit(64)
}

func runPermissionStatus(_ args: [String]) -> Never {
    guard let id = args.first, let kind = PermissionKind(id: id) else { permissionUsage() }
    print(SystemPermissions().status(kind).wireValue)
    exit(0)
}

func runPermissionDialog(_ args: [String]) -> Never {
    guard let id = args.first, let kind = PermissionKind(id: id) else { permissionUsage() }
    let reason = args.firstIndex(of: "--reason").flatMap { index in
        args.indices.contains(index + 1) ? args[index + 1] : nil
    }
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let center = PermissionCenter.shared
        center.onAllDialogsClosed = { NSApp.terminate(nil) }
        if center.require(PermissionNeed(kind, reason: reason, trigger: .userAction)) {
            HubPerf.log("permission-dialog \(kind.rawValue): already granted")
            exit(0)
        }

        guard center.dialogs[kind] != nil else {
            // Another process of this app shows the dialog for this kind and was asked to come forward.
            exit(0)
        }

        app.run()
    }
    exit(0)
}

/// Starts `GenesisTools --permission-dialog <kind>` through Launch Services, so the dialog face is its own responsible
/// process and outlives the face that asked (which exits right after). Waits at most 5 s for the launch.
func launchPermissionDialog(_ kind: PermissionKind, reason: String? = nil) {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.arguments = ["--permission-dialog", kind.rawValue] + (reason.map { ["--reason", $0] } ?? [])
    configuration.createsNewApplicationInstance = true
    configuration.activates = false
    let opened = DispatchSemaphore(value: 0)
    NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { _, error in
        if let error {
            FileHandle.standardError.write(Data("permission dialog did not start: \(error.localizedDescription)\n".utf8))
        }
        opened.signal()
    }
    if opened.wait(timeout: .now() + 5) == .timedOut {
        FileHandle.standardError.write(Data("permission dialog launch had no answer after 5 s\n".utf8))
    }
}

extension GenesisKitHostAdapter {
    /// Asks a new `GenesisTools --permission-status <kind>` process, which reads TCC without this process's cache.
    func probeFreshPermissionStatus(_ kind: PermissionKind) async -> PermissionStatus? {
        guard let executable = Bundle.main.executableURL else { return nil }
        let status: PermissionStatus? = await withCheckedContinuation { continuation in
            let child = Process()
            let output = Pipe()
            child.executableURL = executable
            child.arguments = ["--permission-status", kind.rawValue]
            child.standardInput = FileHandle.nullDevice
            child.standardOutput = output
            child.standardError = FileHandle.nullDevice
            child.terminationHandler = { _ in
                let data = output.fileHandleForReading.readDataToEndOfFile()
                continuation.resume(returning: PermissionStatus(wireValue: String(decoding: data, as: UTF8.self)))
            }
            do {
                try child.run()
            } catch {
                HubPerf.log("permission probe \(kind.rawValue) did not start: \(error.localizedDescription)")
                continuation.resume(returning: nil)
                return
            }

            // A status read takes milliseconds; a probe still running after 5 s is stuck and answers nothing.
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
                if child.isRunning { child.terminate() }
            }
        }
        HubPerf.log("permission probe \(kind.rawValue): \(status?.wireValue ?? "no answer")")
        return status
    }
}
