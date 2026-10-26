import AppKit

/// Which new inbox items alert the user, and the chime that goes with them (Widget settings → Alerts).
public enum WidgetAlerts {
    /// The macOS system sounds in /System/Library/Sounds, offered by the settings page.
    public static let sounds = [
        "Glass", "Ping", "Pop", "Purr", "Submarine", "Tink", "Hero", "Funk", "Blow", "Bottle", "Frog", "Morse",
        "Basso", "Sosumi",
    ]
    public static let defaultSound = "Glass"

    /// The arrivals the preferences ask to hear about: decisions and questions (anything that waits for an answer)
    /// under `alertDecisions`, answers and messages under `alertAnswers`. Agent results never alert.
    public static func wanted(_ items: [WidgetInboxItem], preferences: WidgetPreferences?) -> [WidgetInboxItem] {
        items.filter { item in
            if item.needsAnswer || item.kind == "decision" || item.kind == "form" {
                return preferences?.alertDecisions ?? true
            }
            return item.kind == "answer" && (preferences?.alertAnswers ?? true)
        }
    }

    /// The item a popup shows: the newest one that waits for an answer, else the newest one.
    public static func popupItem(_ items: [WidgetInboxItem]) -> WidgetInboxItem? {
        items.filter(\.needsAnswer).max { $0.at < $1.at } ?? items.max { $0.at < $1.at }
    }

    /// The popup's first line: "Decision 4", "New question", "New answer". Sentence case, one word per thing.
    public static func kicker(_ item: WidgetInboxItem) -> String {
        switch item.kind {
        case "decision": return item.number.map { "Decision \($0)" } ?? "New decision"
        case "form": return "New question"
        case "answer": return "New answer"
        default: return "New in the inbox"
        }
    }

    /// What VoiceOver says when an alert arrives: what it is, its title and the session that sent it.
    public static func announcement(_ item: WidgetInboxItem, session: String?) -> String {
        var parts = [kicker(item)]
        if let title = item.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { parts.append(title) }
        if let session, !session.isEmpty { parts.append("from " + session) }
        return parts.joined(separator: ", ")
    }

    /// Seconds the alert popup stays while the pointer is not on it (`alertPopupSeconds`, default 7); 0 keeps it
    /// until it is closed, answered or opened.
    public static func popupSeconds(_ preferences: WidgetPreferences?) -> Double {
        let seconds = preferences?.alertPopupSeconds ?? 7
        return seconds <= 0 ? 0 : max(3, min(60, seconds))
    }

    /// What the popup does with another alert while it is open (`alertPopupMany`).
    public enum PopupMany: String, Sendable {
        /// The popup keeps the first alert and lists the later ones under it; a click on one shows it.
        case list
        /// The later alerts wait, and each one shows when the one before it closes.
        case queue
        /// The newest alert replaces the one shown.
        case newest
    }

    public static func popupMany(_ preferences: WidgetPreferences?) -> PopupMany {
        preferences?.alertPopupMany.flatMap(PopupMany.init(rawValue:)) ?? .list
    }

    /// The chime's volume, 0 to 1 of the system volume (`alertVolume` in percent, default 100).
    public static func volume(_ preferences: WidgetPreferences?) -> Float {
        Float(max(0, min(100, preferences?.alertVolume ?? 100)) / 100)
    }

    /// The sound for a burst: `alertSound` when anything in it waits for an answer, else the answers' own sound
    /// (`alertAnswerSound`, where "same" means `alertSound`). nil plays the default sound.
    public static func sound(for items: [WidgetInboxItem], preferences: WidgetPreferences?) -> String? {
        let asks = items.contains { $0.needsAnswer || $0.kind == "decision" || $0.kind == "form" }
        guard !asks, let answer = preferences?.alertAnswerSound, answer != "same" else { return preferences?.alertSound }
        return answer
    }

    /// Seconds the session behind an alert flashes in the widget; 0 is off.
    public static func flashSeconds(_ preferences: WidgetPreferences?) -> Double {
        max(0, min(30, preferences?.alertFlashSeconds ?? 5))
    }

    private static var lastChime = Date.distantPast

    /// Plays `name` once at `volume` (0 to 1); a burst of arrivals within 1.5 s chimes once. "none", volume 0 or an
    /// unknown name is silent.
    @MainActor public static func chime(_ name: String?, volume: Float = 1, now: Date = Date()) {
        let sound = name ?? defaultSound
        guard sound != "none", volume > 0, now.timeIntervalSince(lastChime) >= 1.5 else { return }
        lastChime = now
        guard NSSound(named: NSSound.Name(sound)) != nil else {
            PerfLog.mark("widget.alert unknown sound \(sound)")
            return
        }
        play(sound, volume: volume)
    }

    /// `NSSound.play` waits for the output device: about 0.8 s on the main thread on 2026-10-23 (HangWatch), long
    /// enough to freeze the widget the moment an alert arrives. It plays from a background queue instead.
    private static func play(_ name: String, volume: Float) {
        soundQueue.async {
            guard let player = NSSound(named: NSSound.Name(name)) else { return }
            player.volume = volume
            player.play()
            playing.append(player)
            if playing.count > 4 { playing.removeFirst() }
        }
    }

    private static let soundQueue = DispatchQueue(label: "genesiskit.widget.chime", qos: .userInitiated)
    /// Keeps the last few players alive until they finish; a released NSSound stops at once.
    private nonisolated(unsafe) static var playing: [NSSound] = []

    /// Plays `name` now at `volume`, for the settings page's preview button and volume slider.
    @MainActor public static func preview(_ name: String, volume: Float = 1) {
        guard name != "none", volume > 0 else { return }
        play(name, volume: volume)
    }
}
