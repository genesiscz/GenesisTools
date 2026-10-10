import Foundation

/// Every privacy grant GenesisTools and Genesis ask macOS for. The raw value is the id that the denial simulation
/// (`PermissionSimulation`), `GenesisTools --permission-status <id>` and `--permission-dialog <id>` use.
public enum PermissionKind: String, CaseIterable, Identifiable, Sendable, Codable {
    case inputMonitoring = "input-monitoring"
    case accessibility
    case microphone
    case speechRecognition = "speech"
    case screenRecording = "screen-recording"
    case calendars = "calendar"
    case reminders
    case contacts
    case fullDiskAccess = "full-disk-access"
    case automation
    case desktopFolder = "desktop"
    case documentsFolder = "documents"
    case downloadsFolder = "downloads"

    public var id: String { rawValue }

    /// The id, or a short name someone types (`input`, `screen`, `mic`, `fda`).
    public init?(id: String) {
        let key = id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let kind = PermissionKind(rawValue: key) {
            self = kind
            return
        }

        switch key {
        case "input", "listen", "listen-event", "keyboard": self = .inputMonitoring
        case "ax": self = .accessibility
        case "mic": self = .microphone
        case "speech-recognition", "dictation": self = .speechRecognition
        case "screen", "screen-capture", "capture": self = .screenRecording
        case "calendars": self = .calendars
        case "fda", "full-disk", "all-files": self = .fullDiskAccess
        default: return nil
        }
    }

    /// The name System Settings shows for the grant.
    public var title: String {
        switch self {
        case .inputMonitoring: return "Input Monitoring"
        case .accessibility: return "Accessibility"
        case .microphone: return "Microphone"
        case .speechRecognition: return "Speech Recognition"
        case .screenRecording: return "Screen Recording"
        case .calendars: return "Calendars"
        case .reminders: return "Reminders"
        case .contacts: return "Contacts"
        case .fullDiskAccess: return "Full Disk Access"
        case .automation: return "Automation"
        case .desktopFolder: return "Desktop folder"
        case .documentsFolder: return "Documents folder"
        case .downloadsFolder: return "Downloads folder"
        }
    }

    /// One sentence on what the grant lets the app do. A feature passes its own reason when it has a sharper one.
    public var reason: String {
        switch self {
        case .inputMonitoring: return "It lets the app notice which keys you press. It never reads or saves what you type."
        case .accessibility: return "It lets the app paste text and count activity in the app you are using."
        case .microphone: return "It lets the app record your voice for dictation and voice notes."
        case .speechRecognition: return "It lets macOS turn your recorded voice into text."
        case .screenRecording: return "It lets the app take the screenshots you ask for."
        case .calendars: return "It lets tools read and add calendar events."
        case .reminders: return "It lets tools read and add reminders."
        case .contacts: return "It lets tools show names instead of addresses."
        case .fullDiskAccess: return "It lets tools read Mail, Messages and Voice Memos data."
        case .automation: return "It lets tools control System Events for speech and window actions."
        case .desktopFolder, .documentsFolder, .downloadsFolder: return "It lets tools open a file you name in that folder."
        }
    }

    /// The Privacy & Security anchor of the grant's list in System Settings.
    public var settingsAnchor: String {
        switch self {
        case .inputMonitoring: return "Privacy_ListenEvent"
        case .accessibility: return "Privacy_Accessibility"
        case .microphone: return "Privacy_Microphone"
        case .speechRecognition: return "Privacy_SpeechRecognition"
        case .screenRecording: return "Privacy_ScreenCapture"
        case .calendars: return "Privacy_Calendars"
        case .reminders: return "Privacy_Reminders"
        case .contacts: return "Privacy_Contacts"
        case .fullDiskAccess: return "Privacy_AllFiles"
        case .automation: return "Privacy_Automation"
        case .desktopFolder, .documentsFolder, .downloadsFolder: return "Privacy_FilesAndFolders"
        }
    }

    /// The exact System Settings pane.
    public var settingsURL: URL {
        Self.settingsURL(anchor: settingsAnchor)
    }

    /// `x-apple.systempreferences:com.apple.preference.security?<anchor>`; `"Privacy"` opens Privacy & Security itself.
    public static func settingsURL(anchor: String) -> URL {
        // Every anchor is ASCII letters and underscores, so the URL always parses.
        URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!
    }

    public var symbol: String {
        switch self {
        case .inputMonitoring: return "keyboard"
        case .accessibility: return "accessibility"
        case .microphone: return "mic"
        case .speechRecognition: return "waveform"
        case .screenRecording: return "rectangle.dashed.badge.record"
        case .calendars: return "calendar"
        case .reminders: return "checklist"
        case .contacts: return "person.crop.circle"
        case .fullDiskAccess: return "internaldrive"
        case .automation: return "gearshape.2"
        case .desktopFolder, .documentsFolder, .downloadsFolder: return "folder"
        }
    }

    public var requestStyle: PermissionRequestStyle {
        switch self {
        case .microphone, .speechRecognition, .calendars, .reminders, .contacts: return .systemPrompt
        case .accessibility, .screenRecording, .inputMonitoring: return .promptThenSettings
        case .fullDiskAccess: return .settingsOnly
        case .automation, .desktopFolder, .documentsFolder, .downloadsFolder: return .probe
        }
    }

    /// macOS answers these from a per-process cache: a grant given while a process runs is seen only by a new one.
    public var cachedPerProcess: Bool {
        self == .inputMonitoring || self == .screenRecording
    }

    /// The folder a probe lists, for the folder kinds.
    public var folderPath: String? {
        switch self {
        case .desktopFolder: return NSString(string: "~/Desktop").expandingTildeInPath
        case .documentsFolder: return NSString(string: "~/Documents").expandingTildeInPath
        case .downloadsFolder: return NSString(string: "~/Downloads").expandingTildeInPath
        default: return nil
        }
    }
}

/// How macOS lets an app ask for a grant.
public enum PermissionRequestStyle: Sendable, Equatable {
    /// macOS shows its own prompt while the grant is undetermined; afterwards only System Settings can change it.
    case systemPrompt
    /// A request lists the app in System Settings and may show one macOS prompt; the switch itself is in Settings.
    case promptThenSettings
    /// No request exists: the user adds the app in System Settings.
    case settingsOnly
    /// Touching the resource once makes macOS ask.
    case probe
}

/// What macOS reports for a grant.
public enum PermissionStatus: Equatable, Sendable {
    case granted
    case denied
    case notDetermined
    case restricted
    /// A grant that exists but is not enough, e.g. Calendars "Add Only".
    case partial(String)
    /// No status API; the text says how to find out.
    case unknown(String)

    public var isGranted: Bool { self == .granted }

    public var label: String {
        switch self {
        case .granted: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "not asked yet"
        case .restricted: return "restricted"
        case .partial(let what): return what
        case .unknown(let what): return what
        }
    }

    /// One line on stdout of `GenesisTools --permission-status`, read back by `init(wireValue:)`.
    public var wireValue: String {
        switch self {
        case .granted: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .partial(let what): return "partial:\(what)"
        case .unknown(let what): return "unknown:\(what)"
        }
    }

    public init?(wireValue: String) {
        let line = wireValue.trimmingCharacters(in: .whitespacesAndNewlines)
        switch line {
        case "granted": self = .granted
        case "denied": self = .denied
        case "notDetermined": self = .notDetermined
        case "restricted": self = .restricted
        default:
            if line.hasPrefix("partial:") {
                self = .partial(String(line.dropFirst("partial:".count)))
            } else if line.hasPrefix("unknown:") {
                self = .unknown(String(line.dropFirst("unknown:".count)))
            } else {
                return nil
            }
        }
    }
}
