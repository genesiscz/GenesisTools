// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground.worktrees/genesis-session-redesign/Genesis/apps/Genesis/Sources/Genesis/Sessions/SessionSyntaxHighlighter.swift at 2026-09-24T05:05:23+02:00 at commit hash 786292605d31a39fe795dafe34fb0f8d6f96d0a1
//
//  SessionSyntaxHighlighter.swift
//  Genesis
//
//  A small token highlighter for the transcript's code bodies (Write content, Edit diffs, tool
//  output). No WebKit and no grammar files: one character scanner per language family that knows
//  comments, strings, numbers, keywords, types and calls. It is deliberately approximate; a
//  wrong colour costs nothing, a slow one costs a frame.
//
//  Cost: linear in the text, one pass per line, block comments carried across lines. Callers
//  cap the line count and run large bodies off the main thread (`SessionCodeBlock`).
//
//  Portable: Foundation and SwiftUI only.
//

import Foundation
import SwiftUI

enum SyntaxLanguage: String, Equatable, Sendable {
    case swift, typescript, javascript, json, python, shell, go, rust, cLike, java, kotlin, ruby, php
    case css, html, yaml, markdown, sql, toml, plain

    /// By file extension (or a few well-known names).
    static func forPath(_ path: String) -> SyntaxLanguage {
        let name = (path as NSString).lastPathComponent.lowercased()
        switch name {
        case "dockerfile", "makefile": return .shell
        case ".zshrc", ".bashrc", ".zshenv", ".profile": return .shell
        default: break
        }
        switch (name as NSString).pathExtension {
        case "swift": return .swift
        case "ts", "tsx", "mts", "cts": return .typescript
        case "js", "jsx", "mjs", "cjs": return .javascript
        case "json", "jsonc", "jsonl": return .json
        case "py": return .python
        case "sh", "bash", "zsh", "fish": return .shell
        case "go": return .go
        case "rs": return .rust
        case "c", "h", "cc", "cpp", "hpp", "m", "mm": return .cLike
        case "java": return .java
        case "kt", "kts": return .kotlin
        case "rb": return .ruby
        case "php": return .php
        case "css", "scss", "less": return .css
        case "html", "htm", "xml", "svg", "plist", "vue": return .html
        case "yml", "yaml": return .yaml
        case "md", "markdown", "mdx": return .markdown
        case "sql": return .sql
        case "toml": return .toml
        default: return .plain
        }
    }

    fileprivate var lineComment: [String] {
        switch self {
        case .swift, .typescript, .javascript, .go, .rust, .cLike, .java, .kotlin, .php, .json: return ["//"]
        case .python, .shell, .ruby, .yaml, .toml: return ["#"]
        case .sql: return ["--"]
        default: return []
        }
    }

    fileprivate var blockComment: (open: String, close: String)? {
        switch self {
        case .swift, .typescript, .javascript, .go, .rust, .cLike, .java, .kotlin, .php, .css, .json: return ("/*", "*/")
        case .html, .markdown: return ("<!--", "-->")
        default: return nil
        }
    }

    fileprivate var quotes: Set<Unicode.Scalar> {
        switch self {
        case .typescript, .javascript, .shell, .go: return ["\"", "'", "`"]
        case .swift, .rust, .cLike, .java, .kotlin, .json, .css: return ["\""]
        case .markdown, .plain: return []
        default: return ["\"", "'"]
        }
    }

    fileprivate var keywords: Set<String> {
        switch self {
        case .swift:
            return ["func", "let", "var", "if", "else", "guard", "return", "struct", "class", "enum", "protocol", "extension",
                    "import", "private", "fileprivate", "public", "internal", "static", "self", "Self", "init", "deinit", "in",
                    "for", "while", "switch", "case", "default", "break", "continue", "throw", "throws", "try", "await", "async",
                    "some", "any", "where", "true", "false", "nil", "defer", "do", "catch", "inout", "final", "override",
                    "mutating", "lazy", "weak", "unowned", "typealias", "associatedtype", "actor", "nonisolated", "@MainActor"]
        case .typescript, .javascript:
            return ["function", "const", "let", "var", "if", "else", "return", "class", "interface", "type", "enum", "import",
                    "export", "from", "default", "new", "this", "for", "while", "of", "in", "switch", "case", "break",
                    "continue", "throw", "try", "catch", "finally", "await", "async", "true", "false", "null", "undefined",
                    "extends", "implements", "private", "public", "protected", "readonly", "static", "as", "typeof", "keyof",
                    "void", "yield", "declare", "namespace", "satisfies"]
        case .python:
            return ["def", "class", "if", "elif", "else", "return", "import", "from", "as", "for", "while", "in", "not", "and",
                    "or", "is", "None", "True", "False", "try", "except", "finally", "raise", "with", "lambda", "yield", "pass",
                    "break", "continue", "global", "async", "await", "self"]
        case .shell:
            return ["if", "then", "else", "elif", "fi", "for", "do", "done", "while", "case", "esac", "in", "function",
                    "return", "export", "local", "set", "unset", "echo", "cd", "exit", "source"]
        case .go:
            return ["func", "package", "import", "var", "const", "type", "struct", "interface", "if", "else", "for", "range",
                    "return", "switch", "case", "default", "go", "defer", "chan", "map", "nil", "true", "false", "break",
                    "continue", "select"]
        case .rust:
            return ["fn", "let", "mut", "pub", "struct", "enum", "impl", "trait", "use", "mod", "if", "else", "match", "for",
                    "while", "loop", "return", "self", "Self", "true", "false", "as", "ref", "move", "async", "await", "where",
                    "crate", "super", "const", "static", "unsafe", "dyn"]
        case .cLike, .java, .kotlin, .php:
            return ["if", "else", "for", "while", "do", "return", "switch", "case", "default", "break", "continue", "struct",
                    "class", "public", "private", "protected", "static", "const", "void", "int", "char", "float", "double",
                    "long", "bool", "true", "false", "null", "NULL", "nil", "new", "this", "import", "package", "fun", "val",
                    "var", "function", "interface", "extends", "implements", "return", "typedef", "include", "YES", "NO"]
        case .ruby:
            return ["def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "do", "return", "true", "false",
                    "nil", "self", "require", "yield", "begin", "rescue", "ensure", "then"]
        case .sql:
            return ["select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set", "delete",
                    "create", "table", "index", "join", "left", "inner", "on", "as", "order", "by", "group", "limit", "null",
                    "primary", "key", "SELECT", "FROM", "WHERE", "AND", "OR", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
                    "DELETE", "CREATE", "TABLE", "JOIN", "ON", "AS", "ORDER", "BY", "GROUP", "LIMIT", "NULL"]
        case .json, .yaml, .toml:
            return ["true", "false", "null"]
        default:
            return []
        }
    }
}

enum SyntaxToken: Equatable, Sendable {
    case plain, comment, string, number, keyword, type, call, key, flag, heading

    var color: Color {
        switch self {
        case .plain: return Color.white.opacity(0.86)
        case .comment: return Color(red: 0.55, green: 0.58, blue: 0.62)
        case .string: return Color(red: 0.65, green: 0.84, blue: 1.0)
        case .number: return Color(red: 0.47, green: 0.75, blue: 1.0)
        case .keyword: return Color(red: 1.0, green: 0.48, blue: 0.45)
        case .type: return Color(red: 1.0, green: 0.65, blue: 0.34)
        case .call: return Color(red: 0.82, green: 0.66, blue: 1.0)
        case .key: return Color(red: 0.47, green: 0.75, blue: 1.0)
        case .flag: return Color(red: 0.99, green: 0.79, blue: 0.47)
        case .heading: return Color(red: 1.0, green: 0.65, blue: 0.34)
        }
    }
}

/// Scans one language line by line. Keep one instance per block: it carries block-comment state.
struct SyntaxHighlighter {
    let language: SyntaxLanguage
    private var inBlockComment = false

    init(language: SyntaxLanguage) {
        self.language = language
    }

    /// Runs of (token, length in unicode scalars) covering the whole line, in order.
    mutating func runs(_ line: String) -> [(SyntaxToken, Int)] {
        if language == .plain { return [(.plain, line.unicodeScalars.count)] }
        let scalars = Array(line.unicodeScalars)
        var runs: [(SyntaxToken, Int)] = []
        var index = 0

        func push(_ token: SyntaxToken, _ length: Int) {
            guard length > 0 else { return }
            if let last = runs.last, last.0 == token {
                runs[runs.count - 1].1 += length
            } else {
                runs.append((token, length))
            }
        }

        func matches(_ text: String, at position: Int) -> Bool {
            var cursor = position
            for scalar in text.unicodeScalars {
                guard cursor < scalars.count, scalars[cursor] == scalar else { return false }
                cursor += 1
            }
            return true
        }

        if language == .markdown, scalars.first == "#" {
            return [(.heading, scalars.count)]
        }

        var firstWord = true
        while index < scalars.count {
            let scalar = scalars[index]

            if inBlockComment, let block = language.blockComment {
                let start = index
                while index < scalars.count, !matches(block.close, at: index) { index += 1 }
                if index < scalars.count {
                    index += block.close.unicodeScalars.count
                    inBlockComment = false
                }
                push(.comment, index - start)
                continue
            }
            if let block = language.blockComment, matches(block.open, at: index) {
                inBlockComment = true
                push(.comment, block.open.unicodeScalars.count)
                index += block.open.unicodeScalars.count
                continue
            }
            if language.lineComment.contains(where: { matches($0, at: index) }),
               language != .shell || index == 0 || scalars[index - 1] == " " || scalars[index - 1] == "\t" {
                push(.comment, scalars.count - index)
                break
            }
            if language.quotes.contains(scalar) {
                let start = index
                index += 1
                while index < scalars.count, scalars[index] != scalar {
                    index += scalars[index] == "\\" ? 2 : 1
                }
                index = min(index + 1, scalars.count)
                // A JSON / YAML string followed by `:` is a key.
                var after = index
                while after < scalars.count, scalars[after] == " " { after += 1 }
                let isKey = (language == .json || language == .yaml) && after < scalars.count && scalars[after] == ":"
                push(isKey ? .key : .string, index - start)
                firstWord = false
                continue
            }
            if scalar.properties.numericType != nil, scalar.isASCII {
                let start = index
                while index < scalars.count, scalars[index].isASCII,
                      scalars[index].properties.isAlphabetic || scalars[index].properties.numericType != nil || scalars[index] == "." || scalars[index] == "_" {
                    index += 1
                }
                push(.number, index - start)
                firstWord = false
                continue
            }
            if Self.isIdentifierStart(scalar) || (language == .shell && scalar == "-" && (index == 0 || scalars[index - 1] == " ")) || scalar == "@" || (scalar == "$" && language == .shell) {
                let start = index
                index += 1
                while index < scalars.count, Self.isIdentifierPart(scalars[index]) || (language == .shell && scalars[index] == "-") {
                    index += 1
                }
                let word = String(String.UnicodeScalarView(scalars[start..<index]))
                push(classify(word, next: index < scalars.count ? scalars[index] : nil, firstWord: firstWord), index - start)
                firstWord = false
                continue
            }
            if language == .shell, scalar == "|" || scalar == ";" || scalar == "&" {
                firstWord = true
            }
            push(.plain, 1)
            index += 1
        }
        return runs
    }

    private func classify(_ word: String, next: Unicode.Scalar?, firstWord: Bool) -> SyntaxToken {
        switch language {
        case .shell:
            if word.hasPrefix("-") { return .flag }
            if word.hasPrefix("$") { return .type }
            if language.keywords.contains(word) { return .keyword }
            return firstWord ? .call : .plain
        case .yaml, .toml:
            if next == ":" || next == "=" { return .key }
            return language.keywords.contains(word) ? .keyword : .plain
        case .css:
            return next == ":" ? .key : .plain
        case .html:
            return .key
        default:
            if language.keywords.contains(word) { return .keyword }
            if next == "(" { return .call }
            if let first = word.unicodeScalars.first, first.properties.isUppercase { return .type }
            return .plain
        }
    }

    private static func isIdentifierStart(_ scalar: Unicode.Scalar) -> Bool {
        scalar == "_" || (scalar.properties.isAlphabetic && scalar.isASCII)
    }

    private static func isIdentifierPart(_ scalar: Unicode.Scalar) -> Bool {
        scalar == "_" || (scalar.isASCII && (scalar.properties.isAlphabetic || scalar.properties.numericType != nil))
    }
}
