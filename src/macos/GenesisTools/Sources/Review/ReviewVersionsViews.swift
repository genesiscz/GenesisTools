import SwiftUI

// The review window's view of a PR's pushes: the orange Reload in the header, the notice above the
// diff that says who pushed what, and the "Compare pushes" sheet (Review/ReviewVersions.swift).

private let pushOrange = Color(red: 1.0, green: 0.63, blue: 0.12)

/// The header's sign of a newer push: one click moves the diff to it.
struct ReloadPill: View {
    let news: PRPushNews
    let reload: () -> Void

    var body: some View {
        Button(action: reload) {
            Label("Reload", systemImage: "arrow.clockwise")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(.black.opacity(0.85))
                .padding(.horizontal, 9)
                .padding(.vertical, 3)
                .background(Capsule().fill(pushOrange))
        }
        .buttonStyle(.genHoverPlain())
        .fixedSize()
        .instantTooltip("\(news.headline)\nThe diff shows \(news.shown.map { String($0.headSha.prefix(8)) } ?? "an older push"); Reload moves it to \(news.newest.headSha.prefix(8))")
    }
}

/// Above the diff: who pushed, what the new commits are, and the two ways to look at them.
struct PushNewsBanner: View {
    @ObservedObject var model: ReviewModel
    let news: PRPushNews

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            PushAvatar(author: news.newest.pushedBy)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(verbatim: news.headline)
                        .font(.system(size: 12.5, weight: .semibold))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 8)
                    Button("What changed") { model.showChangesSinceShown() }
                        .buttonStyle(.genHoverPlain())
                        .font(.system(size: 12))
                        .fixedSize()
                        .instantTooltip("Only what the author changed since the push on screen. A rebase in between is left out: the older push is replayed onto the new base first.")
                    Button {
                        model.reloadToNewest()
                    } label: {
                        Text("Reload")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(.black.opacity(0.85))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 3)
                            .background(Capsule().fill(pushOrange))
                    }
                    .buttonStyle(.genHoverPlain())
                    .fixedSize()
                    .instantTooltip("Show the PR at its newest push, \(news.newest.headSha.prefix(8))")
                    IconButton(systemName: "xmark", tooltip: "Hide this notice; the orange Reload stays in the header", size: 9.5) {
                        withAnimation(.easeOut(duration: 0.2)) { model.dismissedNewsHead = news.newest.headSha }
                    }
                }
                ForEach(Array(news.newCommits.prefix(4).enumerated()), id: \.offset) { _, commit in
                    HStack(spacing: 6) {
                        Text(verbatim: String(commit.sha.prefix(8)))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(ReviewPalette.dim)
                        Text(verbatim: commit.title)
                            .font(.system(size: 12))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                if news.newCommits.count > 4 {
                    Text(verbatim: "and \(news.newCommits.count - 4) more")
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.dim)
                }
                if news.rebased {
                    Text(verbatim: "Rebased onto \(news.newest.baseSha?.prefix(8) ?? "a newer base"). \"What changed\" leaves the upstream commits out.")
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.dim)
                }
            }
        }
        .padding(.vertical, 9)
        .padding(.leading, 12)
        .padding(.trailing, 10)
        .background(
            RoundedRectangle(cornerRadius: 9)
                .fill(pushOrange.opacity(0.08))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(pushOrange.opacity(0.45), lineWidth: 1))
        )
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2).fill(pushOrange).frame(width: 3).padding(.vertical, 8)
        }
    }
}

/// The pusher's picture, or their initial while it loads or when the host will not give it.
struct PushAvatar: View {
    let author: PRVersion.Author?
    var size: CGFloat = 26

    var body: some View {
        UserAvatar(url: author?.avatarUrl, username: author?.username ?? "?", size: size, tint: pushOrange.opacity(0.85))
            .instantTooltip(author.map { "\($0.name) (@\($0.username))" } ?? "The host did not say who pushed")
    }
}

/// Two pushes to compare. Each row is one push (GitLab's diff versions, GitHub's force pushes and
/// head), newest first; the diff then shows only what changed between them, a rebase left out.
struct ComparePushesSheet: View {
    @ObservedObject var model: ReviewModel
    @ObservedObject var store: PRVersionsStore
    @Environment(\.dismiss) private var dismiss
    @State private var fromID: String?
    @State private var toID: String?

    private var versions: [PRVersion] { store.payload?.versions ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Compare pushes")
                    .font(.system(size: 15, weight: .semibold))
                Text("Pick the older push (From) and the newer one (To). The diff shows what the author changed between them; when the branch was rebased in between, the older push is replayed onto the newer base first, so commits from the target branch do not show up.")
                    .font(.system(size: 12))
                    .foregroundColor(ReviewPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if store.loading && versions.isEmpty {
                ProgressView().controlSize(.small)
                    .frame(maxWidth: .infinity, minHeight: 120)
            } else if let error = store.error, versions.isEmpty {
                Text(error)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(ReviewPalette.removed)
            } else {
                HStack(spacing: 0) {
                    Text("From").frame(width: 44)
                    Text("To").frame(width: 34)
                    Text("Push")
                    Spacer()
                }
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(ReviewPalette.dim)
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(Array(versions.enumerated()), id: \.element.id) { index, version in
                            row(version, number: versions.count - index)
                        }
                    }
                }
                .frame(minHeight: 160, maxHeight: 360)
                if store.payload?.history == false {
                    Text("This host keeps no push history for the PR: only its head is listed.")
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.dim)
                }
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Compare") {
                    guard let from = versions.first(where: { $0.id == fromID }), let to = versions.first(where: { $0.id == toID }) else { return }
                    model.compare(from: CompareEnd(base: from.baseSha, head: from.headSha), to: CompareEnd(base: to.baseSha, head: to.headSha))
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(fromID == nil || toID == nil || fromID == toID)
            }
        }
        .padding(18)
        .frame(width: 620)
        .onAppear {
            store.load()
            pickDefaults()
        }
        .onChange(of: store.payload) { _, _ in pickDefaults() }
    }

    /// To: the newest push. From: the push on screen, else the one before the newest.
    private func pickDefaults() {
        guard fromID == nil || toID == nil, let newest = versions.first else { return }
        toID = toID ?? newest.id
        let shown = model.scope.pinnedHead.flatMap { head in versions.first { PRThreadRendering.sameCommit($0.headSha, head) } }
        fromID = fromID ?? (shown?.id != newest.id ? shown?.id : nil) ?? (versions.count > 1 ? versions[1].id : nil)
    }

    private func row(_ version: PRVersion, number: Int) -> some View {
        let onScreen = model.scope.pinnedHead.map { PRThreadRendering.sameCommit(version.headSha, $0) } ?? false
        return HStack(spacing: 0) {
            radio(selected: fromID == version.id, label: "From push \(version.headSha.prefix(8))") { fromID = version.id }
                .frame(width: 44)
            radio(selected: toID == version.id, label: "To push \(version.headSha.prefix(8))") { toID = version.id }
                .frame(width: 34)
            PushAvatar(author: version.pushedBy, size: 18)
                .padding(.trailing, 8)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(verbatim: "#\(number)")
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    Text(verbatim: String(version.headSha.prefix(8)))
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundColor(ReviewPalette.dim)
                    if let when = version.createdAt.flatMap(HubFormat.date) {
                        Text(when, format: .dateTime.day().month(.abbreviated).hour().minute())
                            .font(.system(size: 11.5))
                            .foregroundColor(ReviewPalette.dim)
                    }
                    if let who = version.pushedBy?.username {
                        Text(verbatim: who)
                            .font(.system(size: 11.5))
                            .foregroundColor(ReviewPalette.dim)
                    }
                    if onScreen {
                        Text("on screen")
                            .font(.system(size: 10.5, weight: .semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.white.opacity(0.12)))
                    }
                }
                if let title = version.commits.first?.title {
                    Text(verbatim: version.commits.count > 1 ? "\(title)  ·  \(version.commits.count) commits" : title)
                        .font(.system(size: 11.5))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .foregroundColor(Color.white.opacity(0.75))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 4)
        .background(RoundedRectangle(cornerRadius: 6).fill(fromID == version.id || toID == version.id ? Color.white.opacity(0.05) : .clear))
    }

    private func radio(selected: Bool, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                .font(.system(size: 13))
                .foregroundColor(selected ? pushOrange : ReviewPalette.dim)
        }
        .buttonStyle(.genHoverPlain())
        .accessibilityLabel(label)
        .accessibilityValue(selected ? "Selected" : "Not selected")
        .instantTooltip("\(label)\(selected ? " · Selected" : "")")
    }
}
