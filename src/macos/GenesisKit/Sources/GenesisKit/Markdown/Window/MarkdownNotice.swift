//
//  MarkdownNotice.swift
//  GenesisKit
//
//  The window's result notices. Each result retains its actions and lifetime in the shared notice stack.
//

import SwiftUI

/// One message for the reader, with the tone the code that wrote it knows.
struct MarkdownNotice: Identifiable {
    enum Tone: Equatable {
        /// Something the reader asked for worked ("Replaced 3 matches").
        case success
        /// Something happened that the reader should know about ("Closed 12 tabs").
        case info
        /// Something did not happen, but nothing is lost ("Nothing found for [[Plan]]").
        case warning
        /// Something failed and needs the reader ("The note could not be saved").
        case error

        /// The shared pill has no info look of its own: an info note reads as a success.
        var pill: NoticePill.Tone {
            switch self {
            case .success, .info: return .success
            case .warning: return .warning
            case .error: return .error
            }
        }
    }

    let id = UUID()
    let text: String
    /// The raw text behind the sentence (stderr, the system's error), shown after a click on Details.
    var more: String?
    let tone: Tone
    /// At most one or two: "Undo", "Open in Preview".
    var actions: [NoticeFix] = []

    init(_ text: String, tone: Tone, more: String? = nil, actions: [NoticeFix] = []) {
        self.text = text
        self.tone = tone
        self.more = more
        self.actions = actions
    }

    /// How long a note stays before it clears by itself; nil for an error, which stays until it is closed. About
    /// 1 s plus 50 ms per word (the checklist's reading time), at least 3 s, and at least 8 s with a button on it so
    /// there is time to reach it.
    var lifetime: TimeInterval? {
        guard tone != .error else { return nil }
        let words = text.split(whereSeparator: \.isWhitespace).count
        let reading = 1 + 0.05 * Double(words)
        return max(actions.isEmpty ? 3 : 8, reading)
    }
}

/// Results over the document area, with independent actions and expiry.
struct MarkdownNoticeSlot: View {
    @ObservedObject var model: MarkdownDocumentsModel

    var body: some View {
        NoticeStackView(model.notices, maxWidth: 440, pinnedTo: .top)
            .padding(10)
            .accessibilityIdentifier("markdown-notice")
    }
}
