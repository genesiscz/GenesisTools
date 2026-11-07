import AppKit
import SwiftUI

// R4 6 animated captions and texts (agent fx-overlay): the inspector controls; the drawing is Render/Overlays.swift.

/// The captions' animation: each line at once, or karaoke (each word coloured as it is said) in a chosen colour.
struct CaptionsStyleSection: View {
    @Bindable var model: EditorModel

    static let colors: [(name: String, hex: String)] = [("Yellow", "#FFD60A"), ("Orange", "#FF9F0A"), ("Green", "#30D158"),
                                                         ("Blue", "#0A84FF"), ("Pink", "#FF375F")]

    var body: some View {
        let style = model.project.captionsStyle
        VStack(alignment: .leading, spacing: 8) {
            GenSegmentedTabs("Captions animation", items: [.init(EditProject.CaptionKind.line, "Whole line"), .init(.karaoke, "Word by word")],
                             selection: Binding(get: { style?.kind ?? .line }, set: { kind in
                                 model.setLooks { project in
                                     if kind == .line {
                                         project.captionsStyle = nil
                                     } else {
                                         var next = project.captionsStyle ?? EditProject.CaptionsStyle()
                                         next.kind = kind
                                         project.captionsStyle = next
                                     }
                                 }
                             }),
                             minSegmentWidth: 90, identifier: "recorder.style.captionsKind", fillsWidth: true)
                .instantTooltip("Word by word colours each word as it is said, from the transcript's word times")
            if let style, style.kind == .karaoke {
                HStack(spacing: 8) {
                    Text("Said words").font(.system(size: 12.5, weight: .medium)).foregroundStyle(RecorderPalette.text)
                    Spacer()
                    ForEach(Self.colors, id: \.hex) { color in
                        let picked = style.color.uppercased() == color.hex
                        Button { model.setLooks { $0.captionsStyle?.color = color.hex } } label: {
                            Circle().fill(Color(nsColor: NSColor(ciColor: Looks.color(color.hex))))
                                .frame(width: 18, height: 18)
                                .overlay(Circle().strokeBorder(Color.white.opacity(picked ? 0.95 : 0), lineWidth: 2))
                        }
                        .buttonStyle(.genHoverPlain())
                        .instantTooltip(color.name)
                        .accessibilityLabel("\(color.name)\(picked ? ", chosen" : "")")
                    }
                }
            }
        }
    }
}

/// A text's way in: a fade (the default), a typewriter or a slide-up, and how long it takes.
struct TextAnimateControls: View {
    let model: EditorModel
    let note: EditProject.TextNote

    var body: some View {
        let id = note.id
        let kind = note.animate?.kind ?? .fade
        VStack(alignment: .leading, spacing: 8) {
            GenSegmentedTabs("Comes in", items: [.init(EditProject.TextAnimation.fade, "Fade"), .init(.typewriter, "Typewriter"),
                                                 .init(.slideUp, "Slide up")],
                             selection: Binding(get: { kind }, set: { value in
                                 model.updateText(id) { text in
                                     text.animate = value == .fade ? nil : EditProject.TextAnimate(kind: value, ms: text.animate?.ms ?? 600)
                                 }
                             }),
                             minSegmentWidth: 70, identifier: "recorder.text.animate", fillsWidth: true)
            if let animate = note.animate {
                SectionLabel(text: "Takes", value: String(format: "%.1f s", Double(animate.ms) / 1000))
                Slider(value: Binding(get: { Double(animate.ms) }, set: { value in
                    model.updateText(id) { $0.animate?.ms = Int((value / 100).rounded() * 100) }
                }), in: 100...3000)
                .accessibilityLabel("How long the text takes to come in")
                .accessibilityIdentifier("recorder.text.animateMs")
            }
        }
    }
}
