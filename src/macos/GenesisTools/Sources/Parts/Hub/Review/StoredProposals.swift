import SwiftUI

/// One stored agent review (`tools hub proposal list --json`): enough to name it in the threads panel and
/// to open its file. A review window launched from a PR link carried no `--proposal`, so the panel said
/// "No open threads" while the agent's review for that very MR sat on disk, or nowhere (2026-10-19, !7561).
struct StoredProposal: Decodable, Identifiable, Equatable {
    struct Author: Decodable, Equatable {
        let agent: String
    }

    struct Verdict: Decodable, Equatable {
        let decision: String
        let summary: String
    }

    private struct DraftStub: Decodable {
        let status: String
    }

    let key: String
    let path: String
    let provider: String
    let host: String
    let project: String
    let number: Int
    let title: String?
    let createdAt: String
    let updatedAt: String?
    let author: Author
    let verdict: Verdict
    let drafts: Int
    let openDrafts: Int

    var id: String { key }
    var identity: PRIdentity { PRIdentity(provider: provider, host: host, project: project, number: number) }
    var pushedAt: String { updatedAt ?? createdAt }

    private enum CodingKeys: String, CodingKey {
        case key, path, provider, host, project, number, title, createdAt, updatedAt, author, verdict, drafts
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decode(String.self, forKey: .key)
        path = try container.decode(String.self, forKey: .path)
        provider = try container.decode(String.self, forKey: .provider)
        host = try container.decode(String.self, forKey: .host)
        project = try container.decode(String.self, forKey: .project)
        number = try container.decode(Int.self, forKey: .number)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        author = try container.decode(Author.self, forKey: .author)
        verdict = try container.decode(Verdict.self, forKey: .verdict)
        let stubs = try container.decodeIfPresent([DraftStub].self, forKey: .drafts) ?? []
        drafts = stubs.count
        openDrafts = stubs.filter { $0.status == "proposed" }.count
    }

    static func parse(_ data: Data) throws -> [StoredProposal] {
        try JSONDecoder().decode([StoredProposal].self, from: data)
    }

    /// The stored reviews of one PR, newest push first. A proposal of another PR never fits this diff.
    static func matching(_ all: [StoredProposal], identity: PRIdentity) -> [StoredProposal] {
        all.filter { $0.identity == identity }.sorted { $0.pushedAt > $1.pushedAt }
    }
}

/// Where the stored reviews of the window's PR stand: not asked yet, asking, or the answer.
enum StoredProposalLookup: Equatable {
    case idle
    case looking(PRIdentity)
    case found(PRIdentity, [StoredProposal])
}

/// The threads panel's "Agent reviews" section while no proposal is attached: the stored reviews of this
/// PR to pick from, or the line that says there is none and how an agent adds one.
struct StoredProposalsList: View {
    @ObservedObject var model: ReviewModel

    var body: some View {
        if model.proposal == nil, model.pr != nil {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text("Agent reviews")
                        .font(.system(size: 11.5, weight: .semibold))
                    Spacer(minLength: 0)
                }
                switch model.storedProposals {
                case .idle, .looking:
                    Text("Looking for a stored review…")
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.dim)
                case .found(let identity, let choices):
                    if choices.isEmpty {
                        Text("No agent review stored for \(identity.label). An agent adds one with tools hub proposal push.")
                            .font(.system(size: 11))
                            .foregroundColor(ReviewPalette.dim)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        ForEach(choices) { choice in
                            StoredProposalRow(choice: choice)
                                .rowButton(cornerRadius: 6) { model.attachProposal(path: choice.path) }
                        }
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            Divider()
        }
    }
}

private struct StoredProposalRow: View {
    let choice: StoredProposal

    private var decisionColor: Color {
        switch choice.verdict.decision {
        case "approve": return ReviewPalette.added
        case "request_changes": return ReviewPalette.removed
        default: return ReviewPalette.modified
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(verbatim: choice.verdict.decision.replacingOccurrences(of: "_", with: " "))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(decisionColor)
                Text(verbatim: choice.author.agent)
                    .font(.system(size: 11.5, weight: .semibold))
                Spacer(minLength: 0)
                LiveAgo(date: HubFormat.date(choice.pushedAt), style: .brief)
                    .font(.system(size: 10.5))
                    .foregroundColor(ReviewPalette.dim)
            }
            HStack(spacing: 6) {
                Text(verbatim: "\(choice.openDrafts) of \(Plural.count(choice.drafts, "draft")) open")
                    .font(.system(size: 11))
                    .foregroundColor(choice.openDrafts > 0 ? ReviewPalette.modified : ReviewPalette.dim)
                if !choice.verdict.summary.isEmpty {
                    Text(verbatim: choice.verdict.summary)
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.dim)
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .instantTooltip("Show \(choice.author.agent)'s review of \(choice.identity.label) on this diff")
    }
}
