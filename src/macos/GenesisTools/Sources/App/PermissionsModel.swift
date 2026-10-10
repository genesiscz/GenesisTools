import AppKit
import Foundation

extension PermissionStatus {
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
    let kind: PermissionKind
    /// which tools command needs it, in one line
    let usedBy: String
    let state: PermissionStatus

    var id: String { kind.rawValue }
    var title: String { kind == .automation ? "Automation (System Events)" : kind.title }
    var pane: String { kind.settingsAnchor }

    var action: GrantAction {
        switch kind.requestStyle {
        case .systemPrompt, .promptThenSettings: return .prompt
        case .settingsOnly: return .openPane(kind.settingsAnchor)
        case .probe: return .probe
        }
    }
}

/// The settings window's list of every grant GenesisTools can hold. Status, requests and panes come from GenesisKit
/// (`PermissionAccess`, the same module the widget's permission dialogs use); this model adds which `tools`
/// command needs each grant and remembers probe answers, which macOS has no status for.
final class PermissionsModel: ObservableObject {
    @Published private(set) var rows: [PermissionRow] = []
    @Published private(set) var busy: String?
    @Published private(set) var lastMessage: String?

    private let access: PermissionAccess
    private var probeResults: [PermissionKind: PermissionStatus] = [:]

    private static let usedBy: [(PermissionKind, String)] = [
        (.calendars, "tools macos calendar, tools todo sync"),
        (.reminders, "tools macos reminders, tools todo"),
        (.contacts, "tools macos mail / messages (sender names)"),
        (.speechRecognition, "tools transcribe, voice-memos transcribe, Flow dictation"),
        (.microphone, "tools ask (voice dictation), Flow, Voice Notes"),
        (.fullDiskAccess, "tools macos mail, messages, voice-memos"),
        (.accessibility, "tools macos control, tools control, Flow paste, Focus activity"),
        (.inputMonitoring, "Clicky keyboard sounds"),
        (.screenRecording, "tools control record / screenshots, widget Capture"),
        (.automation, "tools say, tools macos control, AppleScript helpers"),
        (.desktopFolder, "a file you name there (HAR files, exports)"),
        (.documentsFolder, "a file you name there (HAR files, exports)"),
        (.downloadsFolder, "a file you name there (HAR files, exports)"),
    ]

    init(access: PermissionAccess = .live) {
        self.access = access
    }

    func refresh() {
        rows = Self.usedBy.map { kind, usedBy in
            PermissionRow(kind: kind, usedBy: usedBy, state: probeResults[kind] ?? access.status(kind))
        }
    }

    // MARK: - Actions

    func request(_ row: PermissionRow) {
        busy = row.id
        lastMessage = nil
        let kind = row.kind
        Task { @MainActor in
            let result = await access.request(kind)
            if kind.requestStyle == .probe {
                probeResults[kind] = result
                if result == .denied { lastMessage = "\(row.title): macOS refused. Allow it in System Settings." }
            }

            busy = nil
            refresh()
        }
    }

    func openPane(_ pane: String) {
        if let kind = PermissionKind.allCases.first(where: { $0.settingsAnchor == pane }) {
            MainActor.assumeIsolated { _ = access.openSettings(kind) }
        } else {
            NSWorkspace.shared.open(PermissionKind.settingsURL(anchor: pane))
        }
    }

    func revealApp() {
        PathOpener.reveal(Bundle.main.bundlePath)
    }
}
