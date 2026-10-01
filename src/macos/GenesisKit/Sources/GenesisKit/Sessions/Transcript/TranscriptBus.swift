import Foundation
import SwiftUI

// MARK: - Transcript bus

/// What the sidebar asks of the transcript. A jump goes to the host first, which loads the window
/// holding the turn when it is before the loaded one, then tells the list to reveal the row.
public enum TranscriptCommand: Equatable {
    case jump(turnIndex: Int, rowId: String)
    case reveal(rowId: String)
}

public struct TranscriptMessage {
    public let sessionId: String
    public let command: TranscriptCommand

    public init(
        sessionId: String,
        command: TranscriptCommand
    ) {
        self.sessionId = sessionId
        self.command = command
    }
}

public enum TranscriptBus {
    /// Sidebar → host (`HubSessionDetailHost`).
    public static let request = Notification.Name("genesiskit.transcript.request")
    /// Host → list (`SessionTranscriptList`, a marked adaptation).
    public static let list = Notification.Name("genesiskit.transcript.list")

    public static func post(_ name: Notification.Name, sessionId: String, _ command: TranscriptCommand) {
        NotificationCenter.default.post(name: name, object: TranscriptMessage(sessionId: sessionId, command: command))
    }

    public static func message(_ note: Notification, for name: Notification.Name, sessionId: String) -> TranscriptCommand? {
        guard note.name == name, let message = note.object as? TranscriptMessage, !sessionId.isEmpty, message.sessionId == sessionId else {
            return nil
        }

        return message.command
    }

    /// Only the calls of one tool, each under its prompt; a prompt with none of them goes.
    public static func onlyTool(_ name: String?, in sections: [TranscriptSection]) -> [TranscriptSection] {
        guard let name else { return sections }
        return sections.compactMap { section in
            var copy = section
            copy.rows = section.rows.filter { row in
                if row.isPrompt { return true }
                if case .tool(let line) = row.kind { return line.name == name }
                return false
            }
            return copy.rows.contains { !$0.isPrompt } ? copy : nil
        }
    }

    /// The visible row that shows `rowId`: the row itself, or the folded group holding that call.
    public static func visibleRow(_ rowId: String, in sections: [TranscriptSection]) -> String? {
        for section in sections {
            for row in section.rows {
                if row.id == rowId { return row.id }
                if case .toolGroup(let group) = row.kind, group.members.contains(where: { $0.id == rowId }) {
                    return row.id
                }
            }
        }
        return nil
    }

    public static func contains(_ rowId: String, in sections: [TranscriptSection]) -> Bool {
        visibleRow(rowId, in: sections) != nil
    }
}

/// The transcript's tool filter per session: set by a click in the sidebar's tool list, cleared by
/// the chip it puts in the transcript toolbar. Keyed by session id so another session opens unfiltered.
@MainActor
public final class TranscriptFilters: ObservableObject {
    public static let shared = TranscriptFilters()
    @Published private(set) var tools: [String: String] = [:]

    public func tool(for sessionId: String) -> String? { tools[sessionId] }

    public func setTool(_ name: String?, for sessionId: String) {
        guard !sessionId.isEmpty, tools[sessionId] != name else { return }
        GenesisKit.log("transcript.toolFilter \(sessionId.prefix(8)) \(name ?? "off")")
        tools[sessionId] = name
    }
}

