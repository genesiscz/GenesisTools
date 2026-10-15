//
//  MarkdownCompletion.swift
//  GenesisKit
//
//  What the caret is in the middle of typing: a `[[wikilink]]` or a `#tag`.
//  The editor asks this before every completion, so the trigger rules live
//  here as plain string work rather than inside the text view.
//

import Foundation

public enum MarkdownCompletion {
    public enum Kind: Equatable, Sendable {
        case wikilink
        case tag
    }

    public struct Request: Equatable, Sendable {
        public var kind: Kind
        /// The part already typed, which the chosen value replaces.
        public var range: NSRange
        public var query: String

        public init(kind: Kind, range: NSRange, query: String) {
            self.kind = kind
            self.range = range
            self.query = query
        }
    }

    /// nil when the caret is in ordinary prose.
    static func request(in text: String, caret: Int) -> Request? {
        let ns = text as NSString
        guard caret >= 0, caret <= ns.length else { return nil }
        let line = ns.lineRange(for: NSRange(location: min(caret, max(0, ns.length - 1)), length: 0))
        let head = ns.substring(with: NSRange(location: line.location, length: max(0, caret - line.location)))

        // `[[` with nothing closing it between there and the caret.
        if let open = head.range(of: "[[", options: .backwards) {
            let typed = String(head[open.upperBound...])
            if !typed.contains("]]"), !typed.contains("\n") {
                let start = line.location + (String(head[..<open.upperBound]) as NSString).length
                return Request(
                    kind: .wikilink,
                    range: NSRange(location: start, length: caret - start),
                    query: typed
                )
            }
        }

        // `#tag`, only at the start of a word, and never a `# heading`.
        if let hash = head.range(of: "#", options: .backwards) {
            let typed = String(head[hash.upperBound...])
            let before = hash.lowerBound == head.startIndex ? nil : head[head.index(before: hash.lowerBound)]
            let opensWord = before == nil || before == " " || before == "\t" || before == "(" || before == "["
            let bare = typed.range(of: #"^[\w/\-À-ž]*$"#, options: .regularExpression) != nil
            let heading = head.range(of: #"^\s*#+\s"#, options: .regularExpression) != nil
            if opensWord, bare, !heading, !(typed.isEmpty && before == nil) {
                let start = line.location + (String(head[..<hash.upperBound]) as NSString).length
                return Request(
                    kind: .tag,
                    range: NSRange(location: start, length: caret - start),
                    query: typed
                )
            }
        }
        return nil
    }

    /// What goes into the document once a value is picked. A wikilink closes
    /// its own brackets unless the reader already typed them.
    static func insertion(_ value: String, kind: Kind, followedBy rest: String) -> String {
        switch kind {
        case .tag:
            return value
        case .wikilink:
            return rest.hasPrefix("]]") ? value : value + "]]"
        }
    }
}
