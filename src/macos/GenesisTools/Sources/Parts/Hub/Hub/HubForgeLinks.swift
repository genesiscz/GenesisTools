import Foundation

/// The web pages of one GitHub or GitLab project: a user's profile, a branch, a compare view, a
/// commit, a label's PR list. Built from the origin facts `tools` returns (`kind` + `web`, see
/// src/utils/git/origins/web.ts), so every hub view links through the same rules instead of
/// pasting URL strings. Nil for any other host: a guessed page is worse than plain text.
package struct ForgeWeb: Equatable {
    package enum Kind: String {
        case github
        case gitlab
    }

    package let kind: Kind
    /// `https://host/owner/repo` (GitLab: `https://host/group/sub/project`), an http(s) port kept.
    package let project: String

    package init?(kind: String?, web: String?) {
        guard let kind = kind.flatMap(Kind.init(rawValue:)), let web else { return nil }
        let trimmed = web.hasSuffix("/") ? String(web.dropLast()) : web
        guard let url = URL(string: trimmed), url.host != nil, url.path.count > 1 else { return nil }
        self.kind = kind
        project = trimmed
    }

    /// `https://host[:port]`: user pages live at the host root, not under the project.
    package var hostRoot: String {
        guard let url = URL(string: project) else { return project }
        var components = URLComponents()
        components.scheme = url.scheme
        components.host = url.host
        components.port = url.port
        return components.string ?? project
    }

    /// Another project on the same host (a fork), by its path (`owner/repo`).
    package func sibling(_ path: String) -> ForgeWeb? {
        ForgeWeb(kind: kind.rawValue, web: "\(hostRoot)/\(path)")
    }

    /// GitLab puts project pages under `/-/`.
    private var pages: String { kind == .gitlab ? "\(project)/-" : project }

    /// A user's profile. GitHub apps (`app/dependabot` in `gh` output) live under `/apps/<name>`.
    package func user(_ login: String) -> URL? {
        let login = login.trimmingCharacters(in: .whitespaces)
        guard !login.isEmpty else { return nil }
        if kind == .github, login.hasPrefix("app/") {
            return URL(string: "\(hostRoot)/apps/\(Self.encodeSegment(String(login.dropFirst(4))))")
        }

        return URL(string: "\(hostRoot)/\(Self.encodeSegment(login))")
    }

    package func branch(_ name: String) -> URL? {
        guard !name.isEmpty, name != "HEAD" else { return nil }
        return URL(string: "\(pages)/tree/\(Self.encodePath(name))")
    }

    /// `base...head`. A head in a fork: GitHub names it `owner:branch`; GitLab has no such URL.
    package func compare(base: String, head: String, headOwner: String? = nil) -> URL? {
        guard !base.isEmpty, !head.isEmpty else { return nil }
        if let headOwner {
            guard kind == .github else { return nil }
            return URL(string: "\(pages)/compare/\(Self.encodePath(base))...\(Self.encodeSegment(headOwner)):\(Self.encodePath(head))")
        }

        return URL(string: "\(pages)/compare/\(Self.encodePath(base))...\(Self.encodePath(head))")
    }

    /// The project that holds a PR's head branch: this one, or the fork the host named; nil for a
    /// fork it did not name.
    package func head(crossRepository: Bool?, headRepo: String?) -> ForgeWeb? {
        guard crossRepository == true else { return self }
        return headRepo.flatMap(sibling)
    }

    /// A PR's `base...head`, the head possibly in a fork: nil for a fork the host did not name.
    package func compare(base: String, head: String, crossRepository: Bool?, headRepo: String?) -> URL? {
        guard crossRepository == true else { return compare(base: base, head: head) }
        guard let owner = headRepo?.split(separator: "/").first else { return nil }
        return compare(base: base, head: head, headOwner: String(owner))
    }

    package func commit(_ sha: String) -> URL? {
        guard !sha.isEmpty else { return nil }
        return URL(string: "\(pages)/commit/\(Self.encodeSegment(sha))")
    }

    /// A file at a commit, at a line when given: the host's copy, for a diff whose new side no
    /// checkout on disk holds (a PR without a local worktree).
    package func blob(_ sha: String, path: String, line: Int? = nil) -> URL? {
        guard !sha.isEmpty, !path.isEmpty else { return nil }
        let anchor = line.map { "#L\($0)" } ?? ""
        return URL(string: "\(pages)/blob/\(Self.encodeSegment(sha))/\(Self.encodePath(path))\(anchor)")
    }

    /// `#n`: GitHub serves issues and PRs from one number space and redirects `/issues/n` to the
    /// PR; GitLab's `#n` is always an issue.
    package func issue(_ number: Int) -> URL? {
        URL(string: "\(pages)/issues/\(number)")
    }

    /// A PR by number (GitHub `/pull/n`), or a GitLab MR (`!n`, `/-/merge_requests/n`).
    package func pullRequest(_ number: Int) -> URL? {
        URL(string: kind == .gitlab ? "\(pages)/merge_requests/\(number)" : "\(project)/pull/\(number)")
    }

    /// The project's PRs/MRs with this label.
    package func label(_ name: String) -> URL? {
        guard !name.isEmpty, var components = URLComponents(string: kind == .gitlab ? "\(pages)/merge_requests" : "\(project)/pulls") else { return nil }
        components.queryItems = kind == .gitlab
            ? [URLQueryItem(name: "label_name[]", value: name)]
            : [URLQueryItem(name: "q", value: "is:pr label:\"\(name)\"")]
        return components.url
    }

    /// A branch or path: every character a URL path cannot carry is escaped, `/` stays.
    package static func encodePath(_ value: String) -> String {
        value.split(separator: "/", omittingEmptySubsequences: false).map { encodeSegment(String($0)) }.joined(separator: "/")
    }

    /// One path segment: `/`, `#`, `?`, `%` and spaces are escaped too.
    package static func encodeSegment(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/;")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

extension HubPR {
    /// The PR's own project (base branch, commits, labels, users).
    package var forge: ForgeWeb? { ForgeWeb(kind: origin?.kind, web: origin?.web) }

    /// The project that holds the head branch: a fork's, when the host named it; nil for a fork it did not name.
    package var headForge: ForgeWeb? { forge?.head(crossRepository: crossRepository, headRepo: headRepo) }

    package var authorURL: URL? { author.flatMap { forge?.user($0) } }
    package var headBranchURL: URL? { headForge?.branch(headBranch) }
    package var baseBranchURL: URL? { forge?.branch(baseBranch) }

    /// GitHub serves a fork PR's commits from the base project too; a GitLab fork's live only in the fork.
    package func commitURL(_ sha: String) -> URL? {
        commitForge?.commit(sha)
    }

    /// The project that serves the PR's commits and their files.
    package var commitForge: ForgeWeb? { isGitLab ? headForge : forge }

    /// A file of one of the PR's commits, by the same rule as `commitURL`.
    package func blobURL(_ sha: String, path: String, line: Int? = nil) -> URL? {
        commitForge?.blob(sha, path: path, line: line)
    }

    package var compareURL: URL? {
        forge?.compare(base: baseBranch, head: headBranch, crossRepository: crossRepository, headRepo: headRepo)
    }
}
