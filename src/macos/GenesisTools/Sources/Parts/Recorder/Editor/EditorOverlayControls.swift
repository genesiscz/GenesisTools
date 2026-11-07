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

// R4 10 progress bar and chapter strip
/// The bar along the bottom: on or off, its colour and height, and whether each marker's name shows as it starts.
struct ProgressBarSection: View {
    @Bindable var model: EditorModel

    private func set(_ change: @escaping (inout EditProject.ProgressBar) -> Void) {
        model.setLooks { project in
            var bar = project.progress ?? EditProject.ProgressBar()
            change(&bar)
            project.progress = bar
        }
    }

    var body: some View {
        let bar = model.project.progress
        VStack(alignment: .leading, spacing: 8) {
            SwitchRow("Progress bar", isOn: Binding(get: { bar?.show == true }, set: { on in set { $0.show = on } }))
                .instantTooltip("A thin bar along the bottom of the movie showing how much has played, divided at the markers")
                .accessibilityIdentifier("recorder.style.progress")
            if let bar, bar.show {
                HStack(spacing: 8) {
                    Text("Colour").font(.system(size: 12.5, weight: .medium)).foregroundStyle(RecorderPalette.text)
                    Spacer()
                    ForEach([("White", "#FFFFFF")] + CaptionsStyleSection.colors.map { ($0.name, $0.hex) }, id: \.1) { name, hex in
                        let picked = bar.color.uppercased() == hex
                        Button { set { $0.color = hex } } label: {
                            Circle().fill(Color(nsColor: NSColor(ciColor: Looks.color(hex))))
                                .frame(width: 18, height: 18)
                                .overlay(Circle().strokeBorder(Color.accentColor.opacity(picked ? 1 : 0), lineWidth: 2))
                        }
                        .buttonStyle(.genHoverPlain())
                        .instantTooltip(name)
                        .accessibilityLabel("\(name)\(picked ? ", chosen" : "")")
                    }
                }
                SectionLabel(text: "Height", value: String(format: "%.1f %%", bar.height * 100))
                Slider(value: Binding(get: { bar.height }, set: { value in set { $0.height = (value * 1000).rounded() / 1000 } }), in: 0.002...0.03)
                    .accessibilityLabel("Progress bar height")
                    .accessibilityIdentifier("recorder.style.progressHeight")
                SwitchRow("Chapter names", isOn: Binding(get: { bar.chapters }, set: { on in set { $0.chapters = on } }))
                    .instantTooltip("Each marker's name shows at the top left when its chapter starts")
                    .accessibilityIdentifier("recorder.style.progressChapters")
                if bar.chapters {
                    SectionLabel(text: "Name shows for", value: String(format: "%.1f s", Double(bar.chapterMs) / 1000))
                    Slider(value: Binding(get: { Double(bar.chapterMs) }, set: { value in set { $0.chapterMs = Int((value / 250).rounded() * 250) } }),
                           in: 500...6000)
                        .accessibilityLabel("How long a chapter's name shows")
                }
                if model.markers.isEmpty {
                    Text("No markers yet: the bar has no chapters. Add one from a range on the timeline or with movie.marker().")
                        .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                        .fixedSize(horizontal: false, vertical: true)
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
