import Foundation

// A user turn that holds more than the user's own words: a peer agent's message, a background task's
// result, the Esc marker, a reminder the harness attached. `tools ai sessions tail` splits it into parts
// (GenesisTools src/utils/ai/transcripts/prompt-parts.ts). From GenesisTools Hub/HubPromptParts.swift.

/// One part of a user turn. Flat and all-optional, so a kind this build does not know still decodes and
/// shows as plain text instead of failing the whole envelope.
public struct TranscriptPromptPart: Equatable, Hashable, Sendable, Codable {
    /// `user`, `teammate`, `task`, `interrupt` or `system`.
    public var kind: String
    /// `user`, `interrupt`, `system`.
    public var text: String?
    /// `user`: typed while the agent was working, delivered inside the running turn.
    public var midTurn: Bool?
    /// `teammate`: the sender's name, its colour, the summary it gave, the payload type, the markdown body.
    public var from: String?
    public var color: String?
    public var summary: String?
    public var type: String?
    public var body: String?
    /// `task`: the task id, its status, what finished, the output file and a sub-agent's report.
    public var id: String?
    public var status: String?
    public var outputFile: String?
    public var result: String?

    public init(kind: String, text: String? = nil, midTurn: Bool? = nil, from: String? = nil, color: String? = nil,
                summary: String? = nil, type: String? = nil, body: String? = nil, id: String? = nil,
                status: String? = nil, outputFile: String? = nil, result: String? = nil) {
        self.kind = kind
        self.text = text
        self.midTurn = midTurn
        self.from = from
        self.color = color
        self.summary = summary
        self.type = type
        self.body = body
        self.id = id
        self.status = status
        self.outputFile = outputFile
        self.result = result
    }
}
