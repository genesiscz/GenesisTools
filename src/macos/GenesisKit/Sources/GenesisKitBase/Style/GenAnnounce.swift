import AppKit

/// Speaks a short message through VoiceOver for something that changed without the user's action: a new decision, a
/// send that failed, a recording that started. Each post also writes `a11y.announce <text>` to the kit log, so a test
/// or a live check can prove it ran without VoiceOver on.
public enum GenAnnounce {
    public enum Priority {
        case low, medium, high

        var level: NSAccessibilityPriorityLevel {
            switch self {
            case .low: return .low
            case .medium: return .medium
            case .high: return .high
            }
        }
    }

    @MainActor
    public static func post(_ text: String, priority: Priority = .medium) {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        KitHost.log("a11y.announce \(message)")
        // NSApp is nil in a process that never created the application (a test run): log only.
        guard let app = NSApp else { return }
        let element: Any = app.keyWindow ?? app.mainWindow ?? app
        NSAccessibility.post(element: element, notification: .announcementRequested, userInfo: [
            .announcement: message,
            .priority: priority.level.rawValue,
        ])
    }
}
