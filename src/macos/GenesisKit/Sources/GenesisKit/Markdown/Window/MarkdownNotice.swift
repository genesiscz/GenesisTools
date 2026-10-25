//
//  MarkdownNotice.swift
//  GenesisKit
//
//  The window's one message slot (UX audit 2026-10-25, W2, E2, D1). Before, a failed save, "Replaced 3 matches" and a
//  revision error shared one 9.5 pt line in the toolbar: cut to one line, in the accent colour, never cleared and never
//  spoken. Now each message carries its tone, a success fades by itself, an error stays whole until it is closed (the
//  raw text behind Details), and every message is announced to VoiceOver.
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

/// The slot, laid over the top of the document area so it is near what the reader is looking at. One note at a
/// time: a new one replaces the old.
struct MarkdownNoticeSlot: View {
    @ObservedObject var model: MarkdownDocumentsModel

    var body: some View {
        if let notice = model.notice {
            NoticePill(text: notice.text, more: notice.more, tone: notice.tone.pill, fixes: notice.actions) {
                model.dismissNotice(notice.id)
            }
            .id(notice.id)
            .frame(maxWidth: 440, alignment: .trailing)
            .background(model.theme.chrome.opacity(0.92), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
            .padding(10)
            .transition(.opacity)
            .accessibilityIdentifier("markdown-notice")
        }
    }
}
