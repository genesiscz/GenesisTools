import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// Pictures of the Changes mode's scope picker, its commit selector and the segmented tabs, drawn in a hosted window
/// that is never ordered front (alpha 0, behind every window, no mouse). Only when `GIT_PICKER_SHOTS` names a folder:
/// `GIT_PICKER_SHOTS=<dir> GIT_PICKER_SHOT_TAG=<stamp>-git swift test --filter GitPickerShots`.
@MainActor
final class GitPickerShots: XCTestCase {
    static let history: [GitCommit] = {
        let now = Date()
        let rows: [(String, String, String, TimeInterval)] = [
            ("3f9a2c1", "Explain the scope picker in the plan", "alice", 60 * 42),
            ("8b04d7e", "Fix the table that lost its last row", "bob", 3600 * 5),
            ("c51e990", "Add the review checklist", "alice", 3600 * 30),
            ("e27a4b3", "Rename the drafts folder", "carol", 3600 * 24 * 4),
            ("0d6f8a2", "First notes", "alice", 3600 * 24 * 12),
        ]
        return rows.map { row in
            let sha = row.0 + String(repeating: "0", count: 33)
            return GitCommit(sha: sha, short: row.0, subject: row.1, author: row.2, date: now.addingTimeInterval(-row.3))
        }
    }()

    private var folder: URL? {
        ProcessInfo.processInfo.environment["GIT_PICKER_SHOTS"].map { URL(fileURLWithPath: $0) }
    }

    private func shotFolder() throws -> URL {
        guard let folder else { throw XCTSkip("pictures only when GIT_PICKER_SHOTS names a folder") }
        return folder
    }

    private var tag: String {
        ProcessInfo.processInfo.environment["GIT_PICKER_SHOT_TAG"] ?? "git"
    }

    /// The Changes mode's header row as MarkdownChangesPane builds it, light and dark.
    func testScopePickerShot() throws {
        let folder = try shotFolder()
        let rows = VStack(spacing: 0) {
            ForEach([ColorScheme.light, .dark], id: \.self) { scheme in
                VStack(spacing: 0) {
                    ShotHeader(scope: .uncommitted)
                    Divider()
                    ShotHeader(scope: .lastCommit)
                }
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, scheme)
            }
        }
        try HostedShot.write(rows, size: CGSize(width: 760, height: 168), to: folder.appendingPathComponent("\(tag)-scope-picker.png"))
    }

    /// The commit selector of "Last commit", in a light window: the closed control, and the open list below it when
    /// there is one to draw.
    func testCommitPickerShot() throws {
        let folder = try shotFolder()
        let view = VStack(alignment: .leading, spacing: 6) {
            GitScopePicker(scope: .constant(.lastCommit), commit: .constant(nil), history: GitPickerShots.history,
                           shown: GitPickerShots.history[1])
            ShotOpenCommitList()
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, .light)
        try HostedShot.write(view, size: CGSize(width: 980, height: 470), to: folder.appendingPathComponent("\(tag)-commit-picker.png"))
    }

    /// The pill between two segments: frames 0 to 280 ms after the selection moves from Inbox to Conversation.
    func testSegmentedTabsMotionShot() throws {
        let folder = try shotFolder()
        let box = ShotTabsBox()
        let size = CGSize(width: 420, height: 52)
        let view = ShotBoxTabs(box: box).padding(10).frame(maxWidth: .infinity).background(Color(white: 0.11))
            .environment(\.colorScheme, .dark)
        let (window, host) = HostedShot.host(view, size: size)
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        box.selection = "Conversation"
        let start = Date()
        var frames: [NSBitmapImageRep] = []
        for ms in [0, 40, 80, 120, 160, 200, 280] {
            RunLoop.main.run(until: start.addingTimeInterval(Double(ms) / 1000))
            frames.append(try XCTUnwrap(HostedShot.bitmap(host)))
        }
        try HostedShot.writeStrip(frames, to: folder.appendingPathComponent("\(tag)-tabs-motion.png"))
    }

    /// The scope chip and its open list, light and dark. A picture of the new control only: the old one had no list.
    func testScopeListShot() throws {
        let folder = try shotFolder()
        let view = HStack(alignment: .top, spacing: 0) {
            ForEach([ColorScheme.light, .dark], id: \.self) { scheme in
                VStack(alignment: .leading, spacing: 8) {
                    ShotHeader(scope: .uncommitted)
                    ShotOpenScopeList().padding(.leading, 12)
                    Spacer(minLength: 0)
                }
                .frame(width: 420)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, scheme)
            }
        }
        try HostedShot.write(view, size: CGSize(width: 840, height: 330), to: folder.appendingPathComponent("\(tag)-scope-list.png"))
    }

    /// GenSegmentedTabs at rest, on a dark widget panel and in a light window.
    func testSegmentedTabsShot() throws {
        let folder = try shotFolder()
        let view = VStack(spacing: 0) {
            ShotTabs(selection: "Sessions").padding(12).frame(maxWidth: .infinity).background(Color(white: 0.11)).environment(\.colorScheme, .dark)
            ShotTabs(selection: "Inbox").padding(12).frame(maxWidth: .infinity).background(Color(white: 0.97)).environment(\.colorScheme, .light)
        }
        try HostedShot.write(view, size: CGSize(width: 420, height: 112), to: folder.appendingPathComponent("\(tag)-tabs.png"))
    }
}

/// The header row of the Changes mode, with the picker in it.
struct ShotHeader: View {
    let scope: GitFileScope

    var body: some View {
        HStack(spacing: 10) {
            GitScopePicker(scope: .constant(scope), commit: .constant(nil), history: GitPickerShots.history,
                           shown: scope == .lastCommit ? GitPickerShots.history.first : nil)
            Text(verbatim: "+3 −1")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Picker("View", selection: .constant(true)) {
                Text("Rendered").tag(true)
                Text("Lines").tag(false)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
        }
        .font(.system(size: 11))
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .frame(height: 42)
    }
}

final class ShotTabsBox: ObservableObject {
    @Published var selection = "Inbox"
}

struct ShotBoxTabs: View {
    @ObservedObject var box: ShotTabsBox

    var body: some View {
        GenSegmentedTabs("View", items: [.init("Inbox", "Inbox"), .init("Sessions", "Sessions"), .init("Conversation", "Conversation")],
                         selection: $box.selection)
    }
}

struct ShotTabs: View {
    @State var selection: String

    var body: some View {
        GenSegmentedTabs("View", items: [.init("Inbox", "Inbox"), .init("Sessions", "Sessions"), .init("Conversation", "Conversation")],
                         selection: $selection)
    }
}

/// The open commit list as the popover shows it, under the commit chip, with the counts the details would read.
struct ShotOpenCommitList: View {
    var body: some View {
        let stats = [(1, 3, 1, 0), (2, 14, 6, 4), (1, 22, 0, 0), (3, 5, 5, 2), (1, 40, 0, 0)]
        let choices = zip(GitPickerShots.history, stats).map { commit, stat in
            var choice = GitCommitChoice(commit)
            choice.stat = GitCommitStat(files: stat.0 + 1, additions: stat.1 + 9, deletions: stat.2 + 2, fileAdditions: stat.1, fileDeletions: stat.3)
            return choice
        }
        GitCommitPickerList(choices: choices, selection: GitPickerShots.history[1].sha, title: "Commits that changed this file", details: nil) { _ in }
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.12)))
            .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
            .padding(.leading, 120)
    }
}

/// The open scope list, with counts for one file.
struct ShotOpenScopeList: View {
    var body: some View {
        GitScopeList(selection: .uncommitted, counts: [
            .unstaged: GitScopeStat(additions: 3, deletions: 1),
            .staged: .clean,
            .uncommitted: GitScopeStat(additions: 3, deletions: 1),
        ], base: "origin/main", shown: nil) { _ in }
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.12)))
            .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
    }
}
