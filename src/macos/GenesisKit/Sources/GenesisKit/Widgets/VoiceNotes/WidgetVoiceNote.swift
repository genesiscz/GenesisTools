import Foundation

public struct WidgetVoiceNote: Decodable, Identifiable, Equatable, Sendable {
    public struct Clip: Decodable, Equatable, Sendable {
        public let path: String
        public let bytes: Int
        public let durationMs: Double
    }
    public let id: String
    public let revision: Int
    public let createdAt: Double
    public let clip: Clip
    public let text: String
    public let recognizedText: String
    public let transcription: String
    public let error: String?
    public let provider: String?
    /// Recorded from a reply box: its session and decision.
    public var context: WidgetVoiceNoteContext? = nil
}

/// Where a voice note was recorded: a session's reply box, for one decision or a follow-up.
public struct WidgetVoiceNoteContext: Codable, Equatable, Sendable {
    public var sessionKey: String
    public var sessionTitle: String?
    public var decisionId: String?
    public var decisionNumber: Int?
    public var title: String?

    public init(sessionKey: String, sessionTitle: String? = nil, decisionId: String? = nil, decisionNumber: Int? = nil,
                title: String? = nil) {
        self.sessionKey = sessionKey
        self.sessionTitle = sessionTitle
        self.decisionId = decisionId
        self.decisionNumber = decisionNumber
        self.title = title
    }

    /// "DECISION 19 · gt-native-fixes" or the session's title.
    public var label: String {
        [decisionNumber.map { "DECISION \($0)" }, sessionTitle].compactMap { $0 }.joined(separator: " · ")
    }
}

struct WidgetVoiceNoteSnapshot: Decodable {
    let revision: Int
    let notes: [WidgetVoiceNote]
    let statePath: String
}

struct WidgetVoiceNoteResult: Decodable { let note: WidgetVoiceNote }

public struct WidgetVoiceNoteSettings: Sendable {
    /// The `transcribe` command line. An empty setting is left out: it passed `--language ""`, which the vault key
    /// window then showed as a bare `--language.` (Martin's screenshot, 2026-10-23).
    func transcribeArguments(id: String, revision: Int) -> [String] {
        var args = ["transcribe", id, "--revision", String(revision), "--provider", provider]
        for (flag, value) in [("--account", account), ("--model", model), ("--language", language)] {
            if let value, !value.isEmpty { args += [flag, value] }
        }
        return args
    }

    public var provider: String
    public var account: String?
    public var model: String?
    public var language: String?
    public init(provider: String, account: String? = nil, model: String? = nil, language: String? = nil) {
        self.provider = provider
        self.account = account
        self.model = model
        self.language = language
    }
}
