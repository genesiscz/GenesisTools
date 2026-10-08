import AppKit
import SwiftUI

struct HubWidgetDestinationRequest: Identifiable {
    let id = UUID()
    let mode: String
    let session: String?
    let provider: String?
    let context: String?
    let cwd: String?
}

@MainActor
final class HubWidgetDestinationStore: ObservableObject {
    static let shared = HubWidgetDestinationStore()
    @Published var request: HubWidgetDestinationRequest?
}

private struct HubWidgetDestinationModifier: ViewModifier {
    @ObservedObject var model: HubModel
    @ObservedObject private var store = HubWidgetDestinationStore.shared
    func body(content: Content) -> some View {
        content.sheet(item: $store.request) { request in
            HubWidgetDestinationSheet(model: model, request: request) { store.request = nil }
        }
    }
}

extension View {
    func widgetDestination(model: HubModel) -> some View {
        modifier(HubWidgetDestinationModifier(model: model))
    }
}

private struct HubWidgetDestinationSheet: View {
    @ObservedObject var model: HubModel
    let request: HubWidgetDestinationRequest
    let close: () -> Void
    private var session: HubSession? {
        let matches = model.sessions.filter {
            $0.sessionId == request.session && (request.provider == nil || $0.provider == request.provider)
        }
        return matches.count == 1 ? matches[0] : nil
    }
    private var context: String? {
        guard let file = request.context, file.hasPrefix("/"), file.hasSuffix(".md"),
            FileManager.default.fileExists(atPath: file)
        else { return nil }
        return file
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(request.mode == "resume" ? "Resume this session" : "New agent with prepared context").font(
                    .headline)
                Spacer()
                Button("Cancel", action: close)
            }
            Text("The original widget message stays queued. Starting an agent does not mark it sent.")
                .font(.caption).foregroundStyle(.secondary)
            if request.mode == "resume" {
                if let session {
                    LaunchPicker(mode: .resume(session)) { outcome in
                        if let notice = outcome.notice { model.notice = notice }
                        close()
                    }
                } else if model.loadingSessions {
                    ProgressView("Finding the exact session…")
                } else {
                    Text(
                        "No unambiguous resumable lead session was found. Child agents may only be continued by their parent."
                    )
                    .font(.callout).foregroundStyle(.secondary)
                }
            } else if let context {
                Text("Prepared handoff: " + context).font(.caption).textSelection(.enabled)
                Button("Inspect handoff") { NSWorkspace.shared.open(URL(fileURLWithPath: context)) }
                LaunchPicker(
                    mode: .new(
                        cwd: request.cwd ?? session?.cwd ?? NSHomeDirectory(), name: "Widget handoff",
                        prompt: "Read the handoff file at " + context
                            + " and continue its task. The original source conversation remains separate."
                    )
                ) { outcome in
                    if let notice = outcome.notice { model.notice = notice }
                    close()
                }
            } else {
                Text("The prepared handoff file is unavailable. Create a fresh handoff from the widget.")
                    .foregroundStyle(.orange)
            }
        }.padding(20).frame(minWidth: 520)
    }
}
