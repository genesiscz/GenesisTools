import AppKit
import ApplicationServices
import AVFoundation
import Contacts
import EventKit
import Foundation
import Speech

enum GrantState: Equatable {
    case granted
    case denied
    case notDetermined
    case restricted
    /// a grant that exists but is not enough, e.g. Calendar "Add Only"
    case partial(String)
    /// no status API; text explains how to find out
    case unknown(String)

    var label: String {
        switch self {
        case .granted: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "not asked yet"
        case .restricted: return "restricted"
        case .partial(let what): return what
        case .unknown(let what): return what
        }
    }

    var color: NSColor {
        switch self {
        case .granted: return .systemGreen
        case .denied, .restricted: return .systemRed
        case .partial: return .systemOrange
        case .notDetermined, .unknown: return .secondaryLabelColor
        }
    }
}

enum GrantAction: Equatable {
    /// macOS shows its own prompt for this service
    case prompt
    /// no prompt exists: open the pane and reveal the app
    case openPane(String)
    /// touch the resource once so macOS asks (folders, Automation)
    case probe
}

struct PermissionRow: Identifiable, Equatable {
    let id: String
    let title: String
    /// which tools command needs it, in one line
    let usedBy: String
    let state: GrantState
    let action: GrantAction
    let pane: String
}

/// Reads and requests every grant GenesisTools can hold. Requests run from this process, so the
/// prompt names GenesisTools and the answer lands on the same TCC row the CLI checks.
final class PermissionsModel: ObservableObject {
    @Published private(set) var rows: [PermissionRow] = []
    @Published private(set) var busy: String?
    @Published private(set) var lastMessage: String?

    private let eventStore = EKEventStore()
    private var probeResults: [String: GrantState] = [:]

    private static let tccUserDb = NSString(string: "~/Library/Application Support/com.apple.TCC/TCC.db").expandingTildeInPath

    func refresh() {
        rows = [
            PermissionRow(id: "calendar", title: "Calendars", usedBy: "tools macos calendar, tools todo sync",
                          state: calendarState(), action: .prompt, pane: "Privacy_Calendars"),
            PermissionRow(id: "reminders", title: "Reminders", usedBy: "tools macos reminders, tools todo",
                          state: remindersState(), action: .prompt, pane: "Privacy_Reminders"),
            PermissionRow(id: "contacts", title: "Contacts", usedBy: "tools macos mail / messages (sender names)",
                          state: contactsState(), action: .prompt, pane: "Privacy_Contacts"),
            PermissionRow(id: "speech", title: "Speech Recognition", usedBy: "tools transcribe, voice-memos transcribe",
                          state: speechState(), action: .prompt, pane: "Privacy_SpeechRecognition"),
            PermissionRow(id: "microphone", title: "Microphone", usedBy: "tools ask (voice dictation)",
                          state: microphoneState(), action: .prompt, pane: "Privacy_Microphone"),
            PermissionRow(id: "fda", title: "Full Disk Access", usedBy: "tools macos mail, messages, voice-memos",
                          state: fullDiskAccessState(), action: .openPane("Privacy_AllFiles"), pane: "Privacy_AllFiles"),
            PermissionRow(id: "accessibility", title: "Accessibility", usedBy: "tools macos control, tools control",
                          state: accessibilityState(), action: .prompt, pane: "Privacy_Accessibility"),
            PermissionRow(id: "screen", title: "Screen Recording", usedBy: "tools control record / screenshots",
                          state: screenRecordingState(), action: .prompt, pane: "Privacy_ScreenCapture"),
            PermissionRow(id: "automation", title: "Automation (System Events)", usedBy: "tools say, tools macos control, AppleScript helpers",
                          state: probeResults["automation"] ?? .unknown("asks on first use"), action: .probe, pane: "Privacy_Automation"),
            folderRow(id: "desktop", title: "Desktop folder", path: "~/Desktop"),
            folderRow(id: "documents", title: "Documents folder", path: "~/Documents"),
            folderRow(id: "downloads", title: "Downloads folder", path: "~/Downloads"),
        ]
    }

    // MARK: - Actions

    func request(_ row: PermissionRow) {
        busy = row.id
        lastMessage = nil

        switch row.id {
        case "calendar":
            if #available(macOS 14, *) {
                eventStore.requestFullAccessToEvents { _, error in self.finish(row, error) }
            } else {
                eventStore.requestAccess(to: .event) { _, error in self.finish(row, error) }
            }
        case "reminders":
            if #available(macOS 14, *) {
                eventStore.requestFullAccessToReminders { _, error in self.finish(row, error) }
            } else {
                eventStore.requestAccess(to: .reminder) { _, error in self.finish(row, error) }
            }
        case "contacts":
            CNContactStore().requestAccess(for: .contacts) { _, error in self.finish(row, error) }
        case "speech":
            SFSpeechRecognizer.requestAuthorization { _ in self.finish(row, nil) }
        case "microphone":
            AVCaptureDevice.requestAccess(for: .audio) { _ in self.finish(row, nil) }
        case "accessibility":
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
            finish(row, nil)
        case "screen":
            _ = CGRequestScreenCaptureAccess()
            finish(row, nil)
        case "automation":
            probeAutomation(row)
        case "desktop", "documents", "downloads":
            probeFolder(row)
        default:
            openPane(row.pane)
            finish(row, nil)
        }
    }

    func openPane(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }

    func revealApp() {
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    }

    private func finish(_ row: PermissionRow, _ error: Error?) {
        DispatchQueue.main.async {
            self.busy = nil
            if let error {
                self.lastMessage = "\(row.title): \(error.localizedDescription)"
            }
            self.refresh()
        }
    }

    private func probeFolder(_ row: PermissionRow) {
        let path = NSString(string: "~/\(row.title.replacingOccurrences(of: " folder", with: ""))").expandingTildeInPath
        DispatchQueue.global(qos: .userInitiated).async {
            let ok = (try? FileManager.default.contentsOfDirectory(atPath: path)) != nil
            DispatchQueue.main.async {
                self.probeResults[row.id] = ok ? .granted : .denied
                self.finish(row, nil)
            }
        }
    }

    private func probeAutomation(_ row: PermissionRow) {
        DispatchQueue.global(qos: .userInitiated).async {
            var errorInfo: NSDictionary?
            let script = NSAppleScript(source: "tell application \"System Events\" to get name")
            let result = script?.executeAndReturnError(&errorInfo)
            DispatchQueue.main.async {
                self.probeResults["automation"] = result != nil ? .granted : .denied
                if let errorInfo, let message = errorInfo[NSAppleScript.errorMessage] as? String {
                    self.lastMessage = "Automation: \(message)"
                }
                self.finish(row, nil)
            }
        }
    }

    // MARK: - Status readers (never prompt)

    private func calendarState() -> GrantState {
        eventState(EKEventStore.authorizationStatus(for: .event))
    }

    private func remindersState() -> GrantState {
        eventState(EKEventStore.authorizationStatus(for: .reminder))
    }

    private func eventState(_ status: EKAuthorizationStatus) -> GrantState {
        if #available(macOS 14, *) {
            if status == .fullAccess { return .granted }
            if status == .writeOnly { return .partial("Add Only") }
        } else if status == .authorized {
            return .granted
        }

        switch status {
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        default: return .unknown("status \(status.rawValue)")
        }
    }

    private func contactsState() -> GrantState {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        default: return .partial("limited")
        }
    }

    private func speechState() -> GrantState {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown("unknown")
        }
    }

    private func microphoneState() -> GrantState {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown("unknown")
        }
    }

    /// The per-user TCC database is itself behind Full Disk Access: opening it is the probe.
    private func fullDiskAccessState() -> GrantState {
        FileHandle(forReadingAtPath: Self.tccUserDb) != nil ? .granted : .denied
    }

    private func accessibilityState() -> GrantState {
        AXIsProcessTrusted() ? .granted : .notDetermined
    }

    private func screenRecordingState() -> GrantState {
        CGPreflightScreenCaptureAccess() ? .granted : .notDetermined
    }

    private func folderRow(id: String, title: String, path: String) -> PermissionRow {
        PermissionRow(id: id, title: title, usedBy: "a file you name there (HAR files, exports)",
                      state: probeResults[id] ?? .unknown("asks on first use"), action: .probe, pane: "Privacy_FilesAndFolders")
    }
}
