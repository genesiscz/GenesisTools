import SwiftUI

public extension WidgetVoiceNotesStore {
    func voiceNotesModule() -> WidgetModuleDescriptor {
        WidgetModuleDescriptor(id: "voice", title: "Voice Notes", symbol: "waveform", tint: .cyan,
            summary: { self.phase ?? "\(self.notes.count) local notes" },
            visibilityChanged: { self.visibilityChanged($0) }) {
            WidgetVoiceNotesView(store: self, presentation: $0)
        }
    }
}

private struct WidgetVoiceNotesView: View {
    @ObservedObject var store: WidgetVoiceNotesStore
    let presentation: WidgetModulePresentation

    var body: some View {
        Group {
            if presentation == .compact {
                Label(store.phase ?? "Voice Notes", systemImage: "waveform")
                    .font(.system(size: 11, weight: .medium)).foregroundStyle(.cyan)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Label("Voice Notes", systemImage: "waveform").font(.system(size: 15, weight: .semibold))
                        Spacer()
                        Text("\(store.notes.count) local").font(.caption2).foregroundStyle(.secondary)
                        Button { store.refresh(force: true) } label: { Image(systemName: "arrow.clockwise") }
                            .buttonStyle(.plain).accessibilityLabel("Refresh voice notes").disabled(store.isBusy)
                    }
                    if presentation == .expanded {
                        expanded
                    } else {
                        Text(store.selected?.text.isEmpty == false ? (store.selected?.text ?? "") : "Record a thought. Review the words. Attach when ready.")
                            .font(.system(size: 12)).lineLimit(3).foregroundStyle(.secondary)
                        Text("Recordings stay on this Mac until you choose Transcribe.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }.padding(16)
            }
        }
        .accessibilityIdentifier("voice-notes-widget")
    }

    @ViewBuilder private var expanded: some View {
        HStack(spacing: 8) {
            if store.phase == "Recording" {
                Button("Stop and save", systemImage: "stop.fill", action: store.finishRecording)
                    .buttonStyle(.borderedProminent).tint(.cyan)
            } else {
                Button("Record", systemImage: "mic.fill") { store.record() }
                    .buttonStyle(.borderedProminent).tint(.cyan).disabled(store.isBusy)
            }
            Text("Up to 30 seconds").font(.caption2).foregroundStyle(.secondary)
            Spacer()
            if store.isBusy {
                Button("Cancel", action: store.cancel).buttonStyle(.borderless)
            }
        }
        if let phase = store.phase {
            HStack(spacing: 8) {
                SpinningArc(color: .cyan).frame(width: 12, height: 12)
                Text(phase).font(.caption)
                if phase == "Recording" { WidgetVoiceNoteMeterView(meter: store.meter) }
            }
        }
        if let error = store.error {
            Text(error).font(.system(size: 11)).foregroundStyle(KitPalette.removed).textSelection(.enabled)
        } else if let receipt = store.receipt {
            Label(receipt, systemImage: "checkmark.circle").font(.system(size: 11)).foregroundStyle(.secondary)
        }
        if store.notes.isEmpty {
            Spacer(minLength: 0)
            VStack(spacing: 10) {
                Image(systemName: "waveform").font(.system(size: 34, weight: .light)).foregroundStyle(.cyan)
                Text("A place for a quick thought").font(.system(size: 14, weight: .medium))
                Text("Record locally, then choose Transcribe to send the clip to your selected speech provider. A session is only needed when you attach the text.")
                    .font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }.frame(maxWidth: .infinity)
            Spacer(minLength: 0)
        } else {
            Picker("Recording", selection: $store.selectedID) {
                ForEach(store.notes) { note in
                    Text(note.text.isEmpty ? "Recording · \(Int(note.clip.durationMs / 1000))s" : String(note.text.prefix(42)))
                        .tag(Optional(note.id))
                }
            }.disabled(store.isBusy)
            if let note = store.selected {
                HStack {
                    Text("\(Int(note.clip.durationMs / 1000))s · \(note.transcription == "none" ? "Local audio" : note.transcription == "failed" ? "Ready to retry" : "Transcript ready")")
                        .font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    Button(note.transcription == "none" ? "Transcribe" : "Transcribe again", action: store.transcribe)
                        .buttonStyle(.bordered).controlSize(.small).disabled(store.isBusy)
                }
                Text("Transcribe uses \(store.providerLabel), with your voice settings.")
                    .font(.caption2).foregroundStyle(.secondary)
                TextEditor(text: $store.text)
                    .font(.system(size: 12)).scrollContentBackground(.hidden)
                    .padding(8).background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
                    .frame(minHeight: 100).disabled(store.isBusy)
                    .accessibilityLabel("Voice note transcript")
                HStack {
                    Button("Save text", action: store.saveText).buttonStyle(.borderless)
                    Spacer()
                    Button("Discard", role: .destructive, action: store.discard).buttonStyle(.borderless)
                }.font(.caption).disabled(store.isBusy)
                Picker("Attach to", selection: $store.recipientKey) {
                    Text("Choose a session").tag("")
                    ForEach(store.sessions) { session in
                        Text("\(session.title) · \(session.target.provider)").tag(session.key)
                    }
                }.disabled(store.isBusy)
                Button("Attach text to draft", systemImage: "text.badge.plus", action: store.attach)
                    .buttonStyle(.bordered).disabled(store.isBusy || store.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.recipientKey.isEmpty)
                Text("You review and send the session draft separately.").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}

private struct WidgetVoiceNoteMeterView: View {
    @ObservedObject var meter: WidgetVoiceRecordingMeter
    var body: some View {
        HStack(spacing: 7) {
            ProgressView(value: min(1, meter.rms * 6)).progressViewStyle(.linear).tint(.cyan).frame(width: 70)
            Text("\(Int(meter.durationMs / 1000))s").font(.caption2).monospacedDigit()
        }.accessibilityLabel("Recording level")
    }
}
