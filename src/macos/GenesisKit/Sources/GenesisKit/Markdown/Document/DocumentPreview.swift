//
//  DocumentPreview.swift
//  GenesisKit
//
//  The markdown window opens more than markdown. `FileTree.readableExtensions` lets json,
//  yaml, toml, csv, log and txt through as tabs, and every one of them was handed to the
//  markdown renderer unchanged — so a minified JSON cache file rendered as one unwrapped
//  paragraph of prose, with its braces and quotes reflowed like sentences.
//
//  This turns a non-markdown file into markdown the renderer can do justice to. Real markdown
//  is returned untouched, so nothing about the vault changes.
//

import Foundation

enum DocumentPreview {
    /// How a file's text reaches the markdown renderer.
    enum Presentation: Equatable {
        /// Render the text as written. Markdown, and anything unrecognised.
        case markdown
        /// Wrap it in a code fence, highlighted as `language` (empty = no highlighting).
        case fenced(language: String)
        /// Rows and columns, rendered as a real table.
        case table
    }

    /// Rows beyond this are dropped with a note. A 50,000-row table is not a document, and
    /// building one blocks the web view for as long as it takes to lay out.
    static let maximumTableRows = 1000

    static func presentation(for url: URL) -> Presentation {
        switch url.pathExtension.lowercased() {
        case "md", "markdown", "mdx": return .markdown
        case "json": return .fenced(language: "json")
        case "yaml", "yml": return .fenced(language: "yaml")
        case "toml": return .fenced(language: "toml")
        case "csv": return .table
        case "log", "txt", "text": return .fenced(language: "")
        case let ext:
            if let language = codeLanguages[ext] { return .fenced(language: language) }
            return .markdown
        }
    }

    /// Source files by extension, as highlight.js language ids the bundled build registers.
    /// A generator script beside its report (`BoomReport.ts` next to `BoomReport.md`) used
    /// to render as markdown, so its doc comment became bullets and the code one paragraph.
    static let codeLanguages: [String: String] = [
        "ts": "typescript", "tsx": "typescript", "mts": "typescript", "cts": "typescript",
        "js": "javascript", "jsx": "javascript", "mjs": "javascript", "cjs": "javascript",
        "swift": "swift", "py": "python", "rb": "ruby", "go": "go", "rs": "rust",
        "java": "java", "kt": "kotlin", "kts": "kotlin", "php": "php", "lua": "lua", "r": "r",
        "c": "c", "h": "c", "cpp": "cpp", "cc": "cpp", "hpp": "cpp", "m": "objectivec", "mm": "objectivec",
        "cs": "csharp", "sh": "bash", "bash": "bash", "zsh": "bash", "sql": "sql",
        "css": "css", "scss": "scss", "less": "less", "html": "xml", "xml": "xml", "svg": "xml",
        "graphql": "graphql", "gql": "graphql", "ini": "ini", "diff": "diff", "patch": "diff",
        "jsonl": "json", "jsonc": "json",
    ]

    /// The markdown to render for this file.
    static func markdown(for url: URL, text: String) -> String {
        switch presentation(for: url) {
        case .markdown:
            return text
        case .table:
            return table(fromCSV: text) ?? fence(text, language: "")
        case let .fenced(language):
            // Only minified JSON (the whole file on one line) is reformatted. A file that is
            // already laid out, JSON included, is shown as written, so its line numbers and a
            // `range=` or `#L12` link name the lines of the file on disk.
            let minified = !text.trimmingCharacters(in: .whitespacesAndNewlines).contains("\n")
            let body = language == "json" && minified ? (prettyJSON(text) ?? text) : text
            return fence(body, language: language)
        }
    }

    // MARK: - Code fences

    /// A fence long enough to survive its own content: a log that quotes ``` would otherwise
    /// close the block early and render the rest of the file as markdown.
    static func fence(_ text: String, language: String) -> String {
        let body = text.hasSuffix("\n") ? String(text.dropLast()) : text
        let ticks = String(repeating: "`", count: max(3, longestBacktickRun(in: body) + 1))

        return "\(ticks)\(language)\n\(body)\n\(ticks)\n"
    }

    static func longestBacktickRun(in text: String) -> Int {
        var longest = 0
        var run = 0

        for character in text {
            if character == "`" {
                run += 1
                longest = max(longest, run)
            } else {
                run = 0
            }
        }

        return longest
    }

    // MARK: - JSON

    /// Re-indent JSON without re-encoding it.
    ///
    /// `JSONSerialization.prettyPrinted` emits object keys in an arbitrary order, and
    /// `.sortedKeys` emits them alphabetically; either way the document stops matching the
    /// file on disk, which is the one thing a viewer must not do. So this walks the text and
    /// only decides where the line breaks go. Every key, number, escape and unicode sequence
    /// survives exactly as written.
    ///
    /// Returns nil when the text is not JSON, so a broken file is shown as it is rather than
    /// half-formatted.
    static func prettyJSON(_ text: String, indent: String = "  ") -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmed.isEmpty,
              let data = trimmed.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) != nil
        else { return nil }

        let characters = Array(trimmed)
        var out = ""
        var depth = 0
        var index = 0
        var inString = false
        var escaped = false

        func newline(_ level: Int) {
            out.append("\n")
            out.append(String(repeating: indent, count: max(0, level)))
        }

        while index < characters.count {
            let character = characters[index]
            index += 1

            if inString {
                out.append(character)
                if escaped {
                    escaped = false
                } else if character == "\\" {
                    escaped = true
                } else if character == "\"" {
                    inString = false
                }
                continue
            }

            switch character {
            case "\"":
                inString = true
                out.append(character)
            case "{", "[":
                let closing: Character = character == "{" ? "}" : "]"
                var peek = index
                while peek < characters.count, characters[peek].isWhitespace { peek += 1 }

                // An empty object or array stays on one line; `{\n\n}` reads as a mistake.
                if peek < characters.count, characters[peek] == closing {
                    out.append(character)
                    out.append(closing)
                    index = peek + 1
                    continue
                }

                depth += 1
                out.append(character)
                newline(depth)
            case "}", "]":
                depth -= 1
                newline(depth)
                out.append(character)
            case ",":
                out.append(character)
                newline(depth)
            case ":":
                out.append(": ")
            case " ", "\n", "\t", "\r":
                continue
            default:
                out.append(character)
            }
        }

        return out
    }

    // MARK: - CSV

    /// Fields split on commas, with `"` quoting and `""` for a literal quote. Returns nil when
    /// the text holds no separator at all, so a one-column file is fenced rather than shown as
    /// a table of itself.
    static func csvRows(_ text: String) -> [[String]]? {
        guard text.contains(",") else { return nil }

        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var quoted = false
        var index = text.startIndex

        func endField() {
            row.append(field)
            field = ""
        }

        func endRow() {
            endField()
            rows.append(row)
            row = []
        }

        while index < text.endIndex {
            let character = text[index]

            if quoted {
                if character == "\"" {
                    let next = text.index(after: index)
                    if next < text.endIndex, text[next] == "\"" {
                        field.append("\"")
                        index = text.index(after: next)
                        continue
                    }
                    quoted = false
                } else {
                    field.append(character)
                }
                index = text.index(after: index)
                continue
            }

            switch character {
            case "\"":
                quoted = true
            case ",":
                endField()
            // "\r\n" is ONE Character in Swift, so it matches neither "\n" nor
            // "\r" and a CRLF file used to come out as a single row.
            case "\n", "\r\n":
                endRow()
            case "\r":
                break
            default:
                field.append(character)
            }

            index = text.index(after: index)
        }

        if !field.isEmpty || !row.isEmpty { endRow() }

        return rows.isEmpty ? nil : rows
    }

    /// A pipe or a newline inside a cell ends the column or the row it sits in, so both have
    /// to stop being themselves before the cell is printed.
    static func tableCell(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "|", with: "\\|")
            .replacingOccurrences(of: "\r\n", with: "<br>")
            .replacingOccurrences(of: "\n", with: "<br>")
    }

    static func table(fromCSV text: String) -> String? {
        guard let rows = csvRows(text), let header = rows.first else { return nil }

        let width = rows.reduce(0) { max($0, $1.count) }
        guard width > 1 else { return nil }

        func line(_ cells: [String]) -> String {
            let padded = (0..<width).map { $0 < cells.count ? tableCell(cells[$0]) : "" }

            return "| \(padded.joined(separator: " | ")) |"
        }

        var lines = [line(header), "|\(String(repeating: " --- |", count: width))"]
        let body = rows.dropFirst()

        for cells in body.prefix(maximumTableRows) {
            lines.append(line(cells))
        }

        if body.count > maximumTableRows {
            lines.append("")
            lines.append("_\(body.count - maximumTableRows) more rows are in the file; open the source view._")
        }

        return "\(lines.joined(separator: "\n"))\n"
    }
}
