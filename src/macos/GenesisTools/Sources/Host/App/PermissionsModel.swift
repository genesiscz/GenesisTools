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

    var opensSettings: Bool {
        if case .openPane = self { return true }
        return false
    }
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
    /// The id of the row whose request waits for macOS.
    @Published private(set) var busy: String?
    @Published private(set) var lastMessage: String?

    private let access: PermissionAccess
    private var probeResults: [PermissionKind: PermissionStatus] = [:]
    /// The grant `lastMessage` is about: once a refresh finds it no longer refused, the message goes.
    private var messageKind: PermissionKind?
    private var rechecking = false
    /// When the answered probes last ran again; an activation reruns them at most every 10 s.
    private var lastProbeRecheck: Date?

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
        (.localNetwork, "programs started through tools that reach your network (dev servers, Claude sessions)"),
    ]

    init(access: PermissionAccess = .live) {
        self.access = access
    }

    /// The title of the row whose request waits for macOS.
    var busyTitle: String? {
        busy.map { id in rows.first { $0.id == id }?.title ?? id }
    }

    /// Reads every grant again, and runs each answered probe again: a probe grant has no silent read, so without it a
    /// grant changed in System Settings kept its old answer. macOS answered those probes before, so none prompts.
    func refresh() {
        rebuildRows()
        recheckProbes()
    }

    /// The app became active (the user may be back from System Settings). The rows are read again every time; the
    /// answered probes run again at most every `PermissionAccess.activationRecheckInterval`, as the permission center
    /// does, since activating is frequent and an Automation probe runs AppleScript. The Refresh button is not limited.
    func refreshOnActivation(now: Date = Date()) {
        rebuildRows()
        guard PermissionAccess.activationRecheckDue(last: lastProbeRecheck, now: now) else { return }
        recheckProbes(now: now)
    }

    private func rebuildRows() {
        rows = Self.usedBy.map { kind, usedBy in
            PermissionRow(kind: kind, usedBy: usedBy, state: probeResults[kind] ?? access.status(kind))
        }
        if let kind = messageKind, rows.first(where: { $0.kind == kind })?.state != .denied {
            lastMessage = nil
            messageKind = nil
        }
    }

    private func recheckProbes(now: Date = Date()) {
        // PermissionAccess also remembers answers obtained before this settings window opened, including denials.
        // Its recheck guard probes only kinds that macOS has already answered.
        let kinds = PermissionKind.allCases.filter { kind in
            let state = access.status(kind)
            return kind.requestStyle == .probe
                && (probeResults[kind] != nil || state == .granted || state == .denied)
        }
        guard !kinds.isEmpty, !rechecking, busy == nil else { return }
        rechecking = true
        lastProbeRecheck = now
        Task { @MainActor in
            for kind in kinds {
                probeResults[kind] = await access.recheck(kind)
            }
            rechecking = false
            rebuildRows()
        }
    }

    // MARK: - Actions

    func request(_ row: PermissionRow) {
        busy = row.id
        lastMessage = nil
        messageKind = nil
        let kind = row.kind
        Task { @MainActor in
            let result = await access.request(kind)
            if kind.requestStyle == .probe {
                probeResults[kind] = result
                if result == .denied {
                    lastMessage = "\(row.title): macOS refused. Allow it in System Settings."
                    messageKind = kind
                }
            }

            busy = nil
            rebuildRows()
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
