// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Flow/FlowModels.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import Foundation

// MARK: - Phase

/// Where a dictation turn is in its life. Drives the pill's label and colour.
///
/// `injecting` is deliberately its own phase rather than a tail of `thinking`:
/// paste is the step that can fail visibly (no Accessibility permission), and
/// the user needs to see WHICH step failed.
enum FlowPhase: String, Equatable {
    case idle
    case listening
    case transcribing
    case injecting
    case error
}

// MARK: - History

/// One completed dictation. Persisted; the Dictation list renders these.
struct FlowEntry: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    /// Final text, after dictionary + transform.
    var text: String
    /// What the recognizer returned, before any rewriting. Kept so the
    /// auto-learning dictionary can mine variants the user later corrected.
    var rawText: String
    /// Bundle id of the app the text was injected into (`nil` = injection
    /// never ran, e.g. the user dictated with no target).
    var targetBundleId: String?
    /// Human name for the target, resolved at capture time — bundle ids are
    /// stable but unreadable, and resolving later can fail if the app is gone.
    var targetAppName: String?
    var createdAt: Date = Date()
    /// Wall-clock seconds the key was held.
    var durationSeconds: Double
    /// Whether the paste actually landed.
    var injected: Bool

    /// Word count on the FINAL text.
    ///
    /// Stored, not computed in a view body: this feeds the stats header and
    /// `String` splitting in a body would re-run on every invalidation.
    var wordCount: Int

    /// Words per minute for this single turn, `nil` when too short to mean
    /// anything (a 0.4 s "yes" reads as 150 wpm and skews the average).
    var wordsPerMinute: Double? {
        guard durationSeconds >= 1.0, wordCount > 0 else { return nil }
        return Double(wordCount) / (durationSeconds / 60.0)
    }
}

// MARK: - Dictionary

/// A literal replacement applied to every transcript.
///
/// `from` is matched case-insensitively on a word boundary; `to` is inserted
/// verbatim. This is how "next js" becomes "Next.js".
struct FlowDictionaryRule: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var from: String
    var to: String
    var enabled: Bool = true
    /// Set when the rule came from the auto-learner rather than the user, so
    /// the UI can show provenance and the learner can avoid re-suggesting it.
    var learned: Bool = false
    var createdAt: Date = Date()
}

/// Why the analyzer thinks a word deserves a dictionary entry.
enum FlowSuggestionReason: String, Codable {
    /// Heard several spellings of what looks like one term.
    case variantSpread
    /// Not a common English word, looks technical, and recurs.
    case technicalTerm
}

/// A dictionary entry the analyzer proposes; the user accepts or dismisses.
struct FlowSuggestion: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    /// The spelling the recognizer keeps producing.
    var heard: String
    /// The canonical spelling to replace it with — for `technicalTerm` this is
    /// the same as `heard` and the user is expected to correct it.
    var suggested: String
    var reason: FlowSuggestionReason
    var occurrences: Int
    var firstSeen: Date = Date()
}

// MARK: - Snippets

/// A phrase expanded on a spoken trigger. "insert my address" → the address.
struct FlowSnippet: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var trigger: String
    var body: String
    var enabled: Bool = true
}

// MARK: - Transforms

/// A post-dictation rewrite. The prompt is applied to the transcript by the
/// configured AI backend; `nil` prompt means the transform is a no-op marker.
///
/// Transforms are *opt-in per turn* (chosen in the pill or by the default
/// binding), never automatic — an always-on rewrite means the user can no
/// longer trust that what they said is what landed.
struct FlowTransform: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var name: String
    var prompt: String
    var enabled: Bool = true
    /// Optional bundle-id scoping: apply only when injecting into these apps.
    var appBundleIds: [String] = []
    var isDefault: Bool = false
}

// MARK: - Stats

/// Aggregate counters shown in Insights. Derived from history, but cached so
/// the header does not re-reduce the whole array on every view update.
struct FlowStats: Codable, Equatable {
    var totalWords: Int = 0
    var totalSeconds: Double = 0
    var sessionCount: Int = 0
    /// Consecutive days with at least one dictation, counting back from the
    /// most recent day that had one.
    var dayStreak: Int = 0
    var lastDictationAt: Date?

    /// Average words per minute across all turns long enough to count.
    var averageWpm: Double {
        guard totalSeconds >= 1.0, totalWords > 0 else { return 0 }
        return Double(totalWords) / (totalSeconds / 60.0)
    }
}

// MARK: - Config

/// How the user wants the hotkey to behave.
enum FlowActivation: String, Codable, CaseIterable {
    /// Hold the key, speak, release to send.
    case pushToTalk
    /// Tap to start, tap to stop.
    case toggle

    var label: String {
        switch self {
        case .pushToTalk: return "Push to talk"
        case .toggle: return "Toggle"
        }
    }
}

/// Persisted Flow settings. Lives in its own file rather than `client.json`
/// because it is written far more often (every turn touches stats) and
/// `ConfigStore.mutate` takes a cross-process `flock` that the CLI also wants.
struct FlowConfig: Codable, Equatable {
    var enabled: Bool = true
    var activation: FlowActivation = .pushToTalk

    /// Carbon virtual key code. Default `kVK_ANSI_D` (0x02) with ⌃⌥⌘.
    var keyCode: UInt32 = 0x02
    /// Carbon modifier mask. Default `controlKey | optionKey | cmdKey`.
    ///
    /// Until 2026-09-25 the default was ⌃⌥D, which Magnet (and Rectangle,
    /// which copies its defaults) binds to "left third". Carbon registers the
    /// same chord for two processes without an error, so Genesis logged
    /// "registered" while the keystroke went to Magnet from every other app.
    var modifiers: UInt32 = FlowConfig.defaultModifiers

    static let defaultModifiers: UInt32 = 0x1000 | 0x0800 | 0x0100
    static let legacyModifiers: UInt32 = 0x1000 | 0x0800

    /// Locale identifier for the recognizer; empty = system locale.
    var localeIdentifier: String = ""
    /// Force Apple's server recognition instead of on-device.
    var forceServerRecognition: Bool = false

    /// Milliseconds of grace after key release before the recogniser is asked
    /// to finalise, so the last syllable is not clipped.
    var trailingGraceMs: Int = 350

    /// Hold a rolling window of microphone audio so the words spoken just
    /// before the hotkey landed are still captured.
    ///
    /// Fixes the "missing first word" every tool in this category has. Default
    /// **off**: it keeps the microphone open continuously, which macOS shows
    /// with the orange indicator. Nothing is written to disk or transmitted —
    /// the ring overwrites itself in memory — but the mic being live when the
    /// user has not asked for it is a real tradeoff, so they opt in.
    var preRoll: Bool = false

    /// Put the transcript on the clipboard and press ⌘V.
    var injectViaPaste: Bool = true
    /// Restore whatever was on the clipboard before we overwrote it.
    ///
    /// Default **off**, deliberately. Restoring re-exposes the previous
    /// clipboard — often a password or a 2FA code — to any app that polls the
    /// pasteboard on a delay. BridgeVoice shipped the same reversal in 2.5.0.
    var restoreClipboard: Bool = false

    /// Mute system output while recording so the machine does not transcribe
    /// its own audio.
    var muteSystemAudioWhileRecording: Bool = false
    /// Play a short cue on start/stop.
    var soundCues: Bool = true

    /// Auto-learn dictionary candidates from transcripts.
    var dictionaryLearning: Bool = true

    /// Keep at most this many history entries.
    var historyLimit: Int = 2000

    /// Show the floating pill while dictating.
    var showPill: Bool = true

    /// A config saved with the old default ⌃⌥D moves to the new default: that
    /// chord belongs to Magnet and Rectangle, see `modifiers`. Any other chord
    /// is the user's choice and stays.
    func migratingLegacyChord() -> FlowConfig {
        guard keyCode == 0x02, modifiers == Self.legacyModifiers else { return self }
        var migrated = self
        migrated.modifiers = Self.defaultModifiers
        return migrated
    }
}

// MARK: - Global hotkey status

/// Whether a global chord (dictation, voice command) is live. Carbon only
/// reports a refusal inside this process; another app owning the same chord
/// is invisible to it (probed 2026-09-25: even `kEventHotKeyExclusive`
/// returned noErr for ⌃⌥D while Magnet held it).
enum GlobalHotkeyStatus: Equatable {
    /// Turned off (Labs or the feature's own switch).
    case off
    case registered(chord: String)
    /// Carbon refused the registration.
    case unavailable(chord: String)

    /// "Start dictation  ⌃⌥⌘D", or "Start dictation  (shortcut unavailable)".
    func menuTitle(_ action: String) -> String {
        switch self {
        case .off: return action
        case .registered(let chord): return "\(action)  \(chord)"
        case .unavailable: return "\(action)  (shortcut unavailable)"
        }
    }
}
