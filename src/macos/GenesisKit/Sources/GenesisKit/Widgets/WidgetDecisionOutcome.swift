import SwiftUI

/// A settled decision's outcome in its inbox card: the recorded answer and who recorded it, the agent's comments, and
/// the decision that replaced it, which `open` shows.
struct WidgetDecisionOutcome: View {
    let card: WidgetCard
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
                        Text("Superseded by DECISION \(replacement.number)" + (replacement.title.map { ": " + $0 } ?? ""))
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
                    ? "That decision's session is not in the widget" : "Open DECISION \(replacement.number)")
            } else if card.status == "superseded" {
                Label("Superseded", systemImage: "arrow.uturn.right").font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            if !picked.isEmpty || !(card.answer ?? "").isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(card.answeredVia == "agent" ? "Answer recorded by the agent" : "Your answer")
                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                    ForEach(picked, id: \.id) { choice in
                        HStack(alignment: .top, spacing: 6) {
                            Text(verbatim: choice.id).font(.system(size: 10.5, weight: .semibold, design: .rounded))
                                .frame(width: 18, height: 18).background(
                                    Color.green.opacity(0.2), in: RoundedRectangle(cornerRadius: 5))
                            Text(LiveWidgetView.choiceText(choice)).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if let answer = card.answer, !answer.isEmpty {
                        WidgetMarkdown(text: answer)
                    }
                }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.green.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
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

/// The row under a decision's options that opens the composer for the user's own answer.
struct WidgetOwnAnswerRow: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "square.and.pencil").font(.system(size: 10.5, weight: .semibold))
                    .frame(width: 20, height: 20).background(
                        .white.opacity(0.07), in: RoundedRectangle(cornerRadius: 5))
                Text("Write my own answer").font(.system(size: 12)).padding(.top, 2)
                Spacer(minLength: 0)
            }.padding(9).frame(maxWidth: .infinity, alignment: .leading)
                .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 9))
                .contentShape(RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(RowButtonStyle(cornerRadius: 9))
        .instantTooltip("Answer in your own words, with images, a screenshot or voice")
        .accessibilityLabel("Write my own answer")
    }
}
