import AppKit
import CoreImage
import SwiftUI
import UniformTypeIdentifiers

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
                    .instantTooltip("Each marker's name shows when its chapter starts")
                    .accessibilityIdentifier("recorder.style.progressChapters")
                if bar.chapters {
                    // R6 8 chapter label place
                    Picker("Name at", selection: Binding(get: { bar.chapterPlace ?? .auto }, set: { place in set { $0.chapterPlace = place } })) {
                        Text("Free area").tag(EditProject.ChapterPlace.auto)
                        Text("Top left").tag(EditProject.ChapterPlace.topLeft)
                        Text("Top right").tag(EditProject.ChapterPlace.topRight)
                        Text("Bottom left").tag(EditProject.ChapterPlace.bottomLeft)
                        Text("Bottom right").tag(EditProject.ChapterPlace.bottomRight)
                    }
                    .font(.system(size: 12.5))
                    .instantTooltip("Free area puts the name beside the movie (the frame's padding or a phone preset's free side), never over it")
                    .accessibilityIdentifier("recorder.style.progressChapterPlace")
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

// R4 9 intro and end cards
/// The title card before the movie and the end card after it: their words, a logo, a link with its QR code, their
/// length, and a still of each as the export draws it (the preview plays the movie alone).
struct CardsSection: View {
    @Bindable var model: EditorModel

    private func setIntro(_ change: @escaping (inout EditProject.IntroCard?) -> Void) {
        model.setLooks { project in
            var cards = project.cards ?? EditProject.Cards()
            change(&cards.intro)
            project.cards = cards.intro == nil && cards.end == nil ? nil : cards
        }
    }

    private func setEnd(_ change: @escaping (inout EditProject.EndCard?) -> Void) {
        model.setLooks { project in
            var cards = project.cards ?? EditProject.Cards()
            change(&cards.end)
            project.cards = cards.intro == nil && cards.end == nil ? nil : cards
        }
    }

    var body: some View {
        let intro = model.project.cards?.intro
        let end = model.project.cards?.end
        VStack(alignment: .leading, spacing: 8) {
            Text("Cards").font(.system(size: 13, weight: .semibold))
            SwitchRow("Intro card", isOn: Binding(get: { intro != nil }, set: { on in
                setIntro { $0 = on ? EditProject.IntroCard(title: URL(fileURLWithPath: model.project.source.video).deletingPathExtension().lastPathComponent) : nil }
            }))
            .instantTooltip("A title card the export plays before the movie, on the frame's background")
            .accessibilityIdentifier("recorder.style.introCard")
            if let intro {
                field("Title", intro.title) { value in if !value.trimmingCharacters(in: .whitespaces).isEmpty { setIntro { $0?.title = value } } }
                field("Subtitle", intro.subtitle ?? "") { value in setIntro { $0?.subtitle = value.isEmpty ? nil : value } }
                field("Date", intro.date ?? "") { value in setIntro { $0?.date = value.isEmpty ? nil : value } }
                HStack(spacing: 8) {
                    WideButton(title: intro.logo == nil ? "Add a Logo…" : "Other Logo…", systemImage: "photo") {
                        let panel = NSOpenPanel()
                        panel.allowedContentTypes = [.image]
                        panel.message = "A logo for the intro card"
                        guard panel.runModal() == .OK, let url = panel.url else { return }
                        setIntro { $0?.logo = url.path }
                    }
                    if intro.logo != nil {
                        IconButton(systemName: "trash", tooltip: "Remove the logo") { setIntro { $0?.logo = nil } }
                    }
                }
                seconds("Intro lasts", intro.seconds) { value in setIntro { $0?.seconds = value } }
                CardStill(project: model.project, kind: .intro(intro))
            }
            SwitchRow("End card", isOn: Binding(get: { end != nil }, set: { on in
                setEnd { $0 = on ? EditProject.EndCard(text: "Thanks for watching") : nil }
            }))
            .instantTooltip("A card the export plays after the movie: a line, a link and its QR code")
            .accessibilityIdentifier("recorder.style.endCard")
            if let end {
                field("Text", end.text) { value in if !value.trimmingCharacters(in: .whitespaces).isEmpty { setEnd { $0?.text = value } } }
                field("Link", end.link ?? "") { value in setEnd { card in
                    card?.link = value.isEmpty ? nil : value
                    if value.isEmpty { card?.qr = false }
                } }
                SwitchRow("QR code of the link", isOn: Binding(get: { end.qr }, set: { on in setEnd { $0?.qr = on } }))
                    .disabled(end.link == nil)
                    .accessibilityIdentifier("recorder.style.endCardQR")
                seconds("End card lasts", end.seconds) { value in setEnd { $0?.seconds = value } }
                CardStill(project: model.project, kind: .end(end))
            }
            if intro != nil || end != nil {
                Text("The export plays the cards; the preview plays the movie alone.")
                    .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func field(_ title: String, _ value: String, set: @escaping (String) -> Void) -> some View {
        TextField(title, text: Binding(get: { value }, set: { set(String($0.prefix(200))) }))
            .textFieldStyle(.roundedBorder)
            .accessibilityLabel(title)
    }

    private func seconds(_ title: String, _ value: Double, set: @escaping (Double) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: title, value: String(format: "%.1f s", value))
            Slider(value: Binding(get: { value }, set: { set(($0 * 2).rounded() / 2) }), in: 1...10)
                .accessibilityLabel(title)
        }
    }
}

/// A small still of a card as the export draws it, made off the main thread when the card changes.
private struct CardStill: View {
    let project: EditProject
    let kind: CardSpans.Kind
    @State private var image: CGImage?

    var body: some View {
        Group {
            if let image {
                Image(decorative: image, scale: 2).resizable().aspectRatio(contentMode: .fit)
            } else {
                Rectangle().fill(Color.white.opacity(0.05)).aspectRatio(16 / 9, contentMode: .fit)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .accessibilityLabel("A still of the card")
        .task(id: "\(kind)|\(String(describing: project.frame?.background))") {
            let project = project
            let kind = kind
            image = await Task.detached(priority: .utility) {
                let size = CGSize(width: 640, height: 360)
                let frame = CardSpans.Frame(kind: kind, sinceUs: Looks.cardFadeUs, lengthUs: Looks.cardFadeUs * 3)
                let drawn = Looks.drawCard(frame, project: project, plates: TextPlates(), size: size)
                return CIContext().createCGImage(drawn, from: CGRect(origin: .zero, size: size))
            }.value
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
