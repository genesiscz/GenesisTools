//
//  MarkdownGoTo.swift
//  GenesisKit
//
//  "Go to Location…" (⇧⌘G) in the markdown window, as in Finder: a typed or
//  pasted path. A folder shows in the file tree, a file opens as a tab. The
//  path handling is pure, so the tests need no window.
//

import AppKit

import SwiftUI

enum MarkdownGoTo {
    /// The path a typed or pasted text names: quotes and a trailing newline dropped, `~` expanded,
    /// a `file://` URL read as its path, a relative path taken from `base`. Nil for blank text.
    static func url(from raw: String, base: URL) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.count >= 2, let first = text.first, first == text.last, first == "\"" || first == "'" {
            text = String(text.dropFirst().dropLast())
        }

        guard !text.isEmpty else { return nil }
        if text.hasPrefix("file://"), let url = URL(string: text) {
            return url.standardizedFileURL
        }

        let expanded = (text as NSString).expandingTildeInPath
        let url = expanded.hasPrefix("/") ? URL(fileURLWithPath: expanded) : base.appendingPathComponent(expanded)
        return url.standardizedFileURL
    }

    /// Tab in the field: the longest name the folder's entries share with what was typed, and a
    /// trailing `/` when it names one folder. The text unchanged when nothing matches.
    static func complete(_ raw: String, base: URL, fileManager: FileManager = .default) -> String {
        let typed = raw.trimmingCharacters(in: .whitespaces)
        let expanded = (typed as NSString).expandingTildeInPath
        let absolute = expanded.hasPrefix("/") ? expanded : base.appendingPathComponent(expanded).path
        let endsInSlash = typed.isEmpty || typed.hasSuffix("/")
        let folder = endsInSlash ? absolute : (absolute as NSString).deletingLastPathComponent
        let prefix = endsInSlash ? "" : (absolute as NSString).lastPathComponent
        guard let entries = try? fileManager.contentsOfDirectory(atPath: folder) else { return raw }

        let matches = entries
            .filter { !$0.hasPrefix(".") || prefix.hasPrefix(".") }
            .filter { $0.lowercased().hasPrefix(prefix.lowercased()) }
            .sorted()
        guard let first = matches.first else { return raw }

        var common = first
        for match in matches.dropFirst() {
            while !match.lowercased().hasPrefix(common.lowercased()) {
                common.removeLast()
            }
        }

        let head = endsInSlash ? typed : String(typed.dropLast(prefix.count))
        var completed = head + common
        var isDirectory: ObjCBool = false
        if matches.count == 1,
           fileManager.fileExists(atPath: (folder as NSString).appendingPathComponent(common), isDirectory: &isDirectory),
           isDirectory.boolValue {
            completed += "/"
        }
        return completed
    }
}

/// The ⇧⌘G sheet: one path field, Tab completes, Return goes, Esc cancels.
struct MarkdownGoToSheet: View {
    @ObservedObject var model: MarkdownDocumentsModel
    @State private var text = ""
    @State private var problem: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Go to Location")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(model.theme.text)
            Text("A folder shows in the file tree; a file opens as a tab and the tree stays where it is.")
                .font(.system(size: 11.5))
                .foregroundStyle(model.theme.textSecondary)
            TextField("~/notes or /path/to/file.md", text: $text)
                .textFieldStyle(.roundedBorder)
                .font(GenTypography.mono(12))
                .focused($focused)
                .onSubmit(go)
                .onKeyPress(.tab) {
                    text = MarkdownGoTo.complete(text, base: model.filesRootURL)
                    problem = nil
                    return .handled
                }
                .onChange(of: text) { _, _ in problem = nil }
                .onChange(of: problem) { _, now in if let now { GenAnnounce.post(now) } }
                .accessibilityIdentifier("markdown-goto-field")
            if let problem {
                Label {
                    Text(problem).fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").accessibilityHidden(true)
                }
                .font(.system(size: 11.5))
                .foregroundStyle(Color.genError)
                .accessibilityIdentifier("markdown-goto-problem")
            }
            HStack {
                Spacer()
                Button("Cancel") { model.goToOpen = false }
                    .keyboardShortcut(.cancelAction)
                Button("Go", action: go)
                    .keyboardShortcut(.defaultAction)
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(16)
        .frame(width: 460)
        .onAppear {
            text = (model.filesRootURL.path as NSString).abbreviatingWithTildeInPath + "/"
            focused = true
        }
    }

    private func go() {
        if let failure = model.goTo(text) {
            problem = failure
        } else {
            model.goToOpen = false
        }
    }
}
