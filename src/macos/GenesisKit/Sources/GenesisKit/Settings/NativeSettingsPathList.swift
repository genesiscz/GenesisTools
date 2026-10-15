import AppKit
import SwiftUI

/// A settings block for a list of folders ("Watch these folders", "Never scan"): the title and an Add button on top,
/// then one row per folder with its home-relative path, a Show in Finder button and a Remove button. Add opens the
/// system folder chooser (several at once); a folder already in the list is not added twice. A folder that no longer
/// exists keeps its row and says "Missing", so the user decides; nothing is dropped silently. A `~/` path from a config
/// file is read as the home folder's; the same folder written twice (once with `~`) shows twice but is added once.
///
/// Identifiers: `<identifier>.add`, and per row `<identifier>.row.<index>`, `.reveal.<index>`, `.remove.<index>`.
public struct NativeSettingsPathList: View {
    private let title: String
    private let detail: String?
    private let identifier: String
    @Binding private var paths: [String]
    private let addTitle: String
    private let emptyText: String
    private let allowsFiles: Bool
    private let onCommit: (([String]) -> Void)?
    private let label: ((String) -> String)?
    @State private var missing: Set<String> = []

    /// - Parameters:
    ///   - allowsFiles: the chooser also accepts files (an exclusion list of single files).
    ///   - onCommit: runs with the new list after each add or remove; the binding changes at the same moment.
    ///   - label: how a path reads in its row (the host's own names, "$TMPDIR"); nil writes the home folder as ~.
    public init(
        _ title: String, detail: String? = nil, identifier: String, paths: Binding<[String]>,
        addTitle: String = "Add Folder…", emptyText: String = "No folders yet.", allowsFiles: Bool = false,
        label: ((String) -> String)? = nil,
        onCommit: (([String]) -> Void)? = nil
    ) {
        self.title = title
        self.detail = detail
        self.identifier = identifier
        _paths = paths
        self.addTitle = addTitle
        self.emptyText = emptyText
        self.allowsFiles = allowsFiles
        self.onCommit = onCommit
        self.label = label
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            NativeSettingsRow(title, detail: detail) {
                GhostButton(addTitle, symbol: "plus", tooltip: "Choose folders to add", identifier: identifier + ".add") {
                    choose()
                }
                .fixedSize()
                .nativeSettingsDisabledLook()
            }
            VStack(spacing: 0) {
                if paths.isEmpty {
                    HStack(spacing: 8) {
                        Image(systemName: "folder.badge.plus").font(.system(size: 13))
                            .foregroundStyle(.secondary)
                        Text(verbatim: emptyText).font(.system(size: 12)).foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12).frame(height: 38)
                    .accessibilityIdentifier(identifier + ".empty")
                } else {
                    // By position: a list read from a config file can hold the same path twice.
                    ForEach(Array(paths.enumerated()), id: \.offset) { index, path in
                        if index > 0 { Rectangle().fill(Color.white.opacity(0.06)).frame(height: 0.5).padding(.leading, 38) }
                        row(path, index: index)
                    }
                }
            }
            .background(Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.07), lineWidth: 0.5))
        }
        .task(id: paths) {
            let current = paths
            let gone = await Task.detached(priority: .utility) {
                Set(current.filter { !FileManager.default.fileExists(atPath: Self.expanded($0)) })
            }.value
            if gone != missing { missing = gone }
        }
    }

    private func row(_ path: String, index: Int) -> some View {
        let isMissing = missing.contains(path)
        return HStack(spacing: 10) {
            Image(systemName: isMissing ? "folder.badge.questionmark" : "folder.fill")
                .font(.system(size: 13))
                .foregroundStyle(isMissing ? KitPalette.modified : Color.accentColor.opacity(0.85))
                .frame(width: 18)
            PathLabel(path: Self.expanded(path), font: .system(size: 12, design: .monospaced), showIcons: false,
                      title: label?(path) ?? Self.display(path), color: isMissing ? .secondary : .primary)
            if isMissing {
                Text("Missing").font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(KitPalette.modified)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(KitPalette.modified.opacity(0.14), in: Capsule())
            }
            Spacer(minLength: 6)
            IconButton(systemName: "arrow.up.forward.square", tooltip: "Show in Finder") {
                PathOpener.reveal(Self.expanded(path))
            }
                .disabled(isMissing)
                .accessibilityIdentifier("\(identifier).reveal.\(index)")
            IconButton(systemName: "minus.circle", tooltip: "Remove from the list") { remove(path) }
                .accessibilityIdentifier("\(identifier).remove.\(index)")
        }
        .padding(.leading, 10).padding(.trailing, 8)
        .frame(height: 34)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(identifier).row.\(index)")
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = allowsFiles
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = false
        panel.prompt = "Add"
        panel.message = title
        let handle: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .OK else { return }
            let added = panel.urls.map { $0.standardizedFileURL.path }
            let next = Self.merging(paths, adding: added)
            guard next != paths else { return }
            paths = next
            onCommit?(next)
        }
        if let window = NSApp.keyWindow {
            panel.beginSheetModal(for: window, completionHandler: handle)
        } else {
            panel.begin(completionHandler: handle)
        }
    }

    private func remove(_ path: String) {
        let next = paths.filter { $0 != path }
        guard next != paths else { return }
        paths = next
        onCommit?(next)
    }

    // MARK: - Pure helpers (tested)

    /// `path` with the home folder written as `~`.
    static func display(_ path: String, home: String = NSHomeDirectory()) -> String {
        guard !home.isEmpty else { return path }
        if path == home { return "~" }
        let prefix = home.hasSuffix("/") ? home : home + "/"
        return path.hasPrefix(prefix) ? "~/" + path.dropFirst(prefix.count) : path
    }

    /// `path` with a leading `~` read as the home folder.
    nonisolated static func expanded(_ path: String, home: String = NSHomeDirectory()) -> String {
        if path == "~" { return home }
        guard path.hasPrefix("~/") else { return path }
        return (home.hasSuffix("/") ? String(home.dropLast()) : home) + path.dropFirst()
    }

    /// `paths` with `added` appended in order, without duplicates (a trailing slash or a `~` for the home folder does
    /// not make a new path).
    static func merging(_ paths: [String], adding added: [String], home: String = NSHomeDirectory()) -> [String] {
        func key(_ path: String) -> String {
            var trimmed = expanded(path, home: home)
            while trimmed.count > 1, trimmed.hasSuffix("/") { trimmed.removeLast() }
            return trimmed
        }
        var seen = Set(paths.map(key))
        var result = paths
        for path in added where seen.insert(key(path)).inserted {
            result.append(key(path))
        }
        return result
    }
}
