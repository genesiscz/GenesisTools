import SwiftUI
import UniformTypeIdentifiers

// MARK: - Context

/// The meeting's reference material: files (kept as their paths), links and notes. Drop files on the pane to add them;
/// the pane draws its drop target while a drag is over it.
struct ContextTab: View {
    @Bindable var detail: MeetingDetailModel
    @State private var targeted = false

    var body: some View {
        LoadablePane(state: detail.record, reading: "Reading the context…", retry: detail.reloadRecord) { record in
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Files, links and notes the transcript rules read (quotes, meanings).")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                    WrapLayout(spacing: 8, lineSpacing: 6) {
                        GhostButton("Add files…", symbol: "plus", tooltip: "Choose files to add as context (or drop them here)",
                                    identifier: "meetings.context.addFiles") { chooseFiles() }
                        ContextComposerButton(kind: .link, detail: detail)
                        ContextComposerButton(kind: .note, detail: detail)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14).padding(.vertical, 8)
                Divider()
                if record.context.isEmpty {
                    EmptyState(symbol: "doc.on.doc", text: "No context yet",
                               detail: "Drop a file here, or add a file, a link or a note above.", actionTitle: "Add files…") { chooseFiles() }
                } else {
                    List(record.context) { ref in
                        HStack(spacing: 10) {
                            Image(systemName: ref.kind == "file" ? "doc" : ref.kind == "url" ? "link" : "note.text")
                                .foregroundStyle(.secondary).accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: MeetingsWords.contextTitle(ref)).font(.system(size: 13))
                                if ref.kind == "file" {
                                    PathLabel(path: ref.ref, font: .system(size: 10.5, design: .monospaced), showIcons: false)
                                } else if ref.kind == "url" {
                                    Text(verbatim: ref.ref).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                                }
                                if let note = MeetingsWords.contextNote(ref) {
                                    Text(verbatim: note).font(.system(size: 11.5)).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            IconButton(systemName: "trash", tooltip: "Remove \(MeetingsWords.contextTitle(ref)) from this meeting's context") {
                                detail.removeContext(ref)
                            }
                        }
                        .padding(.vertical, 2)
                        .liveRow()
                    }
                    .listStyle(.inset)
                }
            }
        }
        .overlay {
            if targeted {
                RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentColor, lineWidth: 2)
                    .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                    .overlay { Text("Drop to add as context").font(.system(size: 13, weight: .medium)) }
                    .padding(6)
                    .allowsHitTesting(false)
            }
        }
        .onDrop(of: [.fileURL], isTargeted: $targeted) { providers in
            Task { @MainActor in
                var paths: [String] = []
                for provider in providers {
                    if let url = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) as? Data,
                       let file = URL(dataRepresentation: url, relativeTo: nil) {
                        paths.append(file.path)
                    }
                }
                if !paths.isEmpty { detail.addContext(paths: paths) }
            }
            return true
        }
    }
    private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.prompt = "Add"
        if panel.runModal() == .OK { detail.addContext(paths: panel.urls.map(\.path)) }
    }
}

/// "Add link…" or "Add note…": a popover with the field and an optional title. The fields clear only once the CLI
/// saved the entry, so a refused link keeps what was typed.
private struct ContextComposerButton: View {
    enum Kind: String { case link, note }
    let kind: Kind
    let detail: MeetingDetailModel
    @State private var open = false
    @State private var value = ""
    @State private var title = ""
    @FocusState private var focused: Bool

    var body: some View {
        GhostButton(kind == .link ? "Add link…" : "Add note…", symbol: kind == .link ? "link" : "note.text",
                    tooltip: kind == .link ? "Add a web page the transcript rules read" : "Add a note the transcript rules read",
                    identifier: "meetings.context.add.\(kind.rawValue)") { open = true }
            .popover(isPresented: $open, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 8) {
                    if kind == .link {
                        TextField("https://…", text: $value).focused($focused).onSubmit(add)
                    } else {
                        TextField("The note", text: $value, axis: .vertical).lineLimit(3...6).focused($focused)
                    }
                    TextField("Title (optional)", text: $title).onSubmit(add)
                    HStack {
                        if detail.isBusy("context.add.\(kind.rawValue)") { ProgressView().controlSize(.small) }
                        Spacer()
                        Button("Add", action: add).keyboardShortcut(.defaultAction).disabled(!valid)
                    }
                }
                .textFieldStyle(.roundedBorder)
                .frame(width: 320)
                .padding(12)
                .onAppear { focused = true }
            }
    }

    private var trimmed: String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var valid: Bool {
        kind == .note ? !trimmed.isEmpty : (trimmed.hasPrefix("https://") || trimmed.hasPrefix("http://")) && trimmed.count > 8
    }

    private func add() {
        guard valid else { return }
        let name = title.trimmingCharacters(in: .whitespaces)
        detail.addContext(kind == .link ? .link(trimmed) : .note(trimmed), title: name.isEmpty ? nil : name) {
            value = ""
            title = ""
            open = false
        }
    }
}
