import Foundation

// Commit links. `genesis-tools://hub?pr=<ref>&commit=<sha>` opens the PR and selects that commit in its review
// (`PRsModel.pickPendingCommit`); `genesis-tools://hub?repo=<checkout path|owner/repo>&commit=<sha>` opens the
// commit in its project's Worktrees diff, as Activity's commit rows do (`HubModel.showCommit`). The browser-router
// preset `genesis-hub` turns `https://<link host>/hub?…` into the same link; `tools hub open --print-url` writes it.

/// A commit a link names: 7 to 40 hex characters, matched as a prefix of the full sha.
package enum HubCommitSha {
    /// Lowercased, or nil when it is not 7 to 40 hex characters.
    package static func normalized(_ raw: String) -> String? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard (7...40).contains(text.count), text.allSatisfy(\.isHexDigit) else { return nil }
        return text
    }

    /// The first of `commits` whose sha starts with `sha` (normalized).
    package static func find(_ sha: String, in commits: [HubPRDetail.Commit]) -> HubPRDetail.Commit? {
        commits.first { $0.sha.lowercased().hasPrefix(sha) }
    }

    package static func invalid(_ raw: String) -> String {
        "\(raw.prefix(48)) is not a commit: a link names one by 7 to 40 hex characters"
    }
}

/// A commit to select in one PR's review (`PRsModel.request(_:commit:)`).
package struct PRCommitPick: Equatable {
    package let ref: HubPRRef
    /// Normalized (`HubCommitSha`): a prefix of the commit's sha.
    package let sha: String
    /// When it was asked: only a detail fetched after this can say the PR does not hold the commit.
    package let asked: Date
}

/// A message about one PR for its header (`PRsModel.notice`): a link's commit it does not hold.
package struct PRNotice: Equatable {
    package let ref: HubPRRef
    package let text: String
}

/// The commit row a PR overview scrolls to once (`PRsModel.commitScroll`).
package struct PRCommitScroll: Equatable {
    package let prID: String
    package let sha: String
    /// Two links to one commit scroll twice.
    package let id = UUID()
}

/// The checkout, full sha and subject of a `repo=…&commit=…` link's commit.
package enum HubCommitLookup {
    package struct Found: Equatable {
        package let root: String
        package let sha: String
        package let title: String
    }

    package enum Outcome: Equatable {
        case found(Found)
        case failed(String)
    }

    /// `repo` is a checkout path (any folder inside it), or a forge path such as `owner/repo` that `known` (else a
    /// fresh `tools hub pr projects`) maps to its checkout. Runs git, so off the main thread.
    package static func resolve(repo: String, sha: String, known: [HubPRProject]) -> Outcome {
        let text = repo.trimmingCharacters(in: .whitespacesAndNewlines)
        let folder: String
        if text.hasPrefix("/") || text.hasPrefix("~") {
            folder = (text as NSString).expandingTildeInPath
        } else {
            let projects: [HubPRProject]
            do {
                projects = known.isEmpty ? try PRsModel.fetchProjects() : known
            } catch {
                return .failed("Could not list the projects to find \(text): \(error)")
            }
            guard let root = PRsModel.projectRoot(text, in: projects) else {
                return .failed("No checkout of \(text) under the repo roots, so commit \(sha) cannot open")
            }
            folder = root
        }
        guard FileManager.default.fileExists(atPath: folder) else {
            return .failed("\(folder) is not on this Mac")
        }
        guard let root = WorktreeDiscovery.git(folder, ["rev-parse", "--show-toplevel"])?.trimmed, !root.isEmpty else {
            return .failed("\(folder) is not a git checkout")
        }
        guard let line = WorktreeDiscovery.git(root, ["show", "-s", "--format=%H%x00%s", "\(sha)^{commit}", "--"])?.trimmed,
              let separator = line.firstIndex(of: "\0") else {
            return .failed("Commit \(sha) is not in \((root as NSString).abbreviatingWithTildeInPath) (fetch it first)")
        }
        return .found(Found(root: root, sha: String(line[..<separator]), title: String(line[line.index(after: separator)...])))
    }
}

extension HubModel {
    @MainActor
    package func applyCommitLink(_ outcome: HubCommitLookup.Outcome, request: UUID) {
        guard commitLinkRequest == request else { return }
        switch outcome {
        case .found(let found):
            showCommit(repo: found.root, sha: found.sha, title: found.title)
        case .failed(let message):
            HubPerf.log("hub.commitLink \(message)")
            notice = message
        }
    }

    /// `--commit` without `--pr` (a link's `repo=…&commit=…`): the commit in its project's Worktrees diff. The
    /// checkout and the subject are read off the main thread; a miss is said in the notice, never dropped.
    @MainActor
    package func openCommitLink(_ raw: String, repo: String?) {
        let request = UUID()
        commitLinkRequest = request
        guard let sha = HubCommitSha.normalized(raw) else {
            notice = HubCommitSha.invalid(raw)
            return
        }
        guard let repo, !repo.trimmed.isEmpty else {
            notice = "Commit \(sha) needs its PR (pr=) or its project (repo=) to open"
            return
        }
        cancelSessionNavigation()
        let known = prs.allProjects
        Task {
            let span = HubPerf.begin("hub.commitLink", "\(repo) \(sha)", awaits: true)
            let outcome = await Task.detached(priority: .userInitiated) {
                HubCommitLookup.resolve(repo: repo, sha: sha, known: known)
            }.value
            span.end("resolved")
            applyCommitLink(outcome, request: request)
        }
    }
}
