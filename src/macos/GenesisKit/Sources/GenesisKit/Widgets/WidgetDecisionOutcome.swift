import SwiftUI

/// A settled decision's outcome in its inbox card: the recorded answer and who recorded it, the agent's comments, and
/// the decision that replaced it, which `open` shows.
struct WidgetDecisionOutcome: View {
    let card: WidgetCard
    /// Opens the session of the agent that stored the answer; nil when the widget does not list it, or it is this card's.
    var openAnswerer: (() -> Void)? = nil
    let open: (WidgetCard.SupersededBy) -> Void

    var body: some View {
        let picked = (card.option ?? "").map(String.init).compactMap { letter in
            card.choices.first { $0.id == letter }
        }
        VStack(alignment: .leading, spacing: 6) {
            if let replacement = card.supersededBy {
                Button {
                    open(replacement)
                } label: {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "arrow.uturn.right").font(.system(size: 10.5, weight: .semibold))
                            .padding(.top, 2)
                        Text("Superseded by " + WidgetWords.decision(replacement.number) + (replacement.title.map { ": " + $0 } ?? ""))
                            .font(.system(size: 12, weight: .medium)).lineLimit(2).multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).padding(.top, 3)
                    }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(SessionPalette.blue.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
                        .contentShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(RowButtonStyle(cornerRadius: 8))
                .disabled(replacement.sessionKey == nil)
                .instantTooltip(replacement.sessionKey == nil
                    ? "That decision's session is not in the widget" : "Open " + WidgetWords.decision(replacement.number))
            } else if card.status == "superseded" {
                Label("Superseded", systemImage: "arrow.uturn.right").font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            if !picked.isEmpty || !(card.answer ?? "").isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    WidgetAnsweredByLine(via: card.answeredVia, agent: card.answeredBy, open: openAnswerer)
                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(SessionPalette.secondary)
                    ForEach(picked, id: \.id) { choice in
                        HStack(alignment: .top, spacing: 6) {
                            Text(verbatim: choice.id).font(.system(size: 10.5, weight: .semibold, design: .rounded))
                                .frame(width: 18, height: 18).background(
                                    Color.green.opacity(0.2), in: RoundedRectangle(cornerRadius: 5))
                            // Inline markdown, as the option rows drew it before the answer (`WidgetOptionRow`): an
                            // option's `tools rm ask` is code, not words between two backticks.
                            Text(WidgetOptionText.markdown(LiveWidgetView.choiceText(choice))).font(.system(size: 12))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if let answer = card.answer, !answer.isEmpty {
                        WidgetMarkdown(text: answer)
                    }
                }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.green.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
            }
            // Where the answer went and when, in the hub Inbox footer's words: "Sent 18:31 to the original Claude
            // session", or "Waiting to send since 18:31: why" in orange.
            if let delivery = card.decision?.delivery {
                Text(delivery.line)
                    .font(.system(size: 11))
                    .foregroundStyle(delivery.isQueued ? KitPalette.modified : SessionPalette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            ForEach(Array((card.comments ?? []).enumerated()), id: \.offset) { _, comment in
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "text.bubble").font(.system(size: 10)).foregroundStyle(.secondary).padding(.top, 2)
                    Text(comment).font(.system(size: 11)).foregroundStyle(.secondary).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// Who stored a decision's answer, in `WidgetAlerts.answeredViaText`'s words. With `open`, the line is the link to the
/// session of the agent that stored it: the agent's words are underlined, and a click opens that session (the widget's
/// `WidgetAnsweredBy.sessionKey`, the hub's own row of the same session id). Without it, the plain words.
public struct WidgetAnsweredByLine: View, Equatable {
    let via: String?
    let agent: WidgetAnsweredBy?
    let open: (() -> Void)?
    /// A named agent with a session to open: the line is a link.
    let isLink: Bool

    public init(via: String?, agent: WidgetAnsweredBy?, open: (() -> Void)? = nil) {
        self.via = via
        self.agent = agent
        self.open = agent == nil ? nil : open
        isLink = agent != nil && open != nil
    }

    public var body: some View {
        let words = WidgetAlerts.answeredViaText(via, by: agent)
        if let agent, let open {
            let name = WidgetAlerts.agentText(agent)
            Button(action: open) {
                Text(Self.linked(words, agent: name)).multilineTextAlignment(.leading)
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Open the session of " + name)
            // A link, not a button, for VoiceOver and `tools control find --role link`, as the hub's `ExternalLink`.
            .accessibilityRemoveTraits(.isButton)
            .accessibilityAddTraits(.isLink)
            .accessibilityHint("Opens the session of the agent that recorded the answer")
        } else {
            Text(words)
        }
    }

    /// The line with the agent's words underlined, so the part that names the session reads as its link.
    static func linked(_ words: String, agent: String) -> AttributedString {
        var text = AttributedString(words)
        if let range = text.range(of: agent) {
            text[range][AttributeScopes.SwiftUIAttributes.UnderlineStyleAttribute.self] = .single
        }
        return text
    }

    public nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.via == rhs.via && lhs.agent == rhs.agent && lhs.isLink == rhs.isLink
    }
}
