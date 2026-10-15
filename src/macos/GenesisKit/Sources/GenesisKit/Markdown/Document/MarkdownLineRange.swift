//
//  MarkdownLineRange.swift
//  GenesisKit
//
//  Lines of a file the viewer is asked to show: `genesis-md://open?path=…&range=10-20`,
//  `genesis open --range 10-20`, and a link `[x](/abs/file.ts#L10-L20)` inside a note.
//

import Foundation

/// 1-based, inclusive, counted over the whole file the way an editor and grep count them.
public struct MarkdownLineRange: Equatable, Sendable {
    public let first: Int
    public let last: Int

    public init?(first: Int, last: Int) {
        guard first >= 1, last >= 1 else { return nil }
        self.first = min(first, last)
        self.last = max(first, last)
    }

    /// `30`, `30-50`, `L30`, `L30-50`, `L30-L50` (a lowercase `l` too). A fragment like
    /// `Heading` or `page=2`, and anything with a zero, gives nil.
    public static func parse(_ text: String?) -> MarkdownLineRange? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count <= 2 else { return nil }
        let numbers = parts.map { part -> Int? in
            let digits = part.first == "L" || part.first == "l" ? part.dropFirst() : part[...]
            guard !digits.isEmpty, digits.allSatisfy(\.isASCII), digits.allSatisfy(\.isNumber) else { return nil }
            return Int(digits)
        }
        guard let first = numbers.first ?? nil else { return nil }
        if numbers.count == 1 { return MarkdownLineRange(first: first, last: first) }
        guard let last = numbers[1] else { return nil }
        return MarkdownLineRange(first: first, last: last)
    }

    /// The `range=` query item of an open URL.
    public static func fromQuery(_ items: [URLQueryItem]) -> MarkdownLineRange? {
        parse(items.first(where: { $0.name == "range" })?.value)
    }

    /// `3-6`, or `3` for one line: the `range=` value an open URL carries.
    public var queryValue: String {
        first == last ? "\(first)" : "\(first)-\(last)"
    }

    /// The characters these lines cover in `text`, without the last line's newline. A range
    /// past the end is cut to the last line, so a stale link still lands somewhere.
    func characterRange(in text: String) -> NSRange {
        let starts = SourceEditing.lineStarts(text)
        let firstIndex = min(first - 1, starts.count - 1)
        let lastIndex = min(last - 1, starts.count - 1)
        let start = starts[firstIndex]
        let end = lastIndex + 1 < starts.count ? starts[lastIndex + 1] - 1 : (text as NSString).length
        return NSRange(location: start, length: max(0, end - start))
    }
}

/// The lines the window was asked to show, kept until another tab is selected. The token
/// lets the same range be sent again (a second click on the same link).
struct MarkdownLineHighlight: Equatable {
    var range: MarkdownLineRange
    var token: Int
}

/// What a link inside a rendered note does with a local file it resolved.
enum MarkdownLinkRoute: Equatable {
    /// A markdown note: a tab, scrolled to the heading or to the lines the fragment names.
    case note(URL, heading: String?, lines: MarkdownLineRange?)
    /// A data file the viewer renders as a document (json, yaml, txt, csv, log…): a tab, at
    /// those lines when the link names some.
    case viewer(URL, lines: MarkdownLineRange?)
    /// Code or any other file: a menu offers its default app, this viewer and the sidebar,
    /// so `file.go#L20-L37` never silently does nothing and `file.ts#L20` is not forced
    /// into the viewer.
    case choose(URL, lines: MarkdownLineRange?)
    /// A folder: a menu offers Finder or the file sidebar.
    case folder(URL)

    static let noteExtensions: Set<String> = ["md", "markdown", "mdx"]
    /// The data types the viewer renders as a document, not as highlighted code.
    static let viewerExtensions: Set<String> = FileTree.readableExtensions
        .subtracting(noteExtensions)
        .union(["jsonl", "jsonc"])

    /// `isFile` and `isFolder` are passed in so the decision can be tested without real files.
    /// nil for anything that is neither a regular file nor a folder: an app or another bundle.
    static func decide(
        _ url: URL,
        fragment: String?,
        isFile: (URL) -> Bool = MarkdownLinkRoute.isRegularFile,
        isFolder: (URL) -> Bool = MarkdownLinkRoute.isFolder
    ) -> MarkdownLinkRoute? {
        if isFolder(url) { return .folder(url) }
        guard isFile(url) else { return nil }
        let lines = MarkdownLineRange.parse(fragment)
        let ext = url.pathExtension.lowercased()
        if noteExtensions.contains(ext) {
            return .note(url, heading: lines == nil ? fragment : nil, lines: lines)
        }
        if viewerExtensions.contains(ext) {
            return .viewer(url, lines: lines)
        }
        return .choose(url, lines: lines)
    }

    /// A real folder, not a bundle (an `.app` or a `.rtfd` is a document to its owner).
    static func isFolder(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey]) else { return false }
        return values.isDirectory == true && values.isPackage != true
    }

    static func isRegularFile(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true
    }
}
