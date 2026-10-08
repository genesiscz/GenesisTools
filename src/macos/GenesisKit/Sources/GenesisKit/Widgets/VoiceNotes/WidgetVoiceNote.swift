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
}

struct WidgetVoiceNoteSnapshot: Decodable {
    let revision: Int
    let notes: [WidgetVoiceNote]
    let statePath: String
}

struct WidgetVoiceNoteResult: Decodable { let note: WidgetVoiceNote }

public struct WidgetVoiceNoteSettings: Sendable {
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
