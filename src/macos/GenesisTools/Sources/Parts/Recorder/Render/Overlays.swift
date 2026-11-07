import AppKit
import CoreImage
import Foundation

// R4 6 animated captions and texts (agent fx-overlay): the karaoke caption's words said so far and a text's way in.

/// How far a text's `animate` has come `sinceUs` after its start: the letters a typewriter has typed, and a slide-up's
/// fade and how far below its place it still is (a share of its height).
enum TextMotion {
    struct State: Equatable {
        var characters: Int
        var opacity: Double
        var drop: CGFloat
    }

    static func at(sinceUs: Int64?, note: EditProject.TextNote) -> State {
        let full = State(characters: note.text.count, opacity: 1, drop: 0)
        guard let sinceUs, let animate = note.animate else { return full }
        let progress = min(1, max(0, Double(sinceUs) / Double(max(1, animate.ms) * 1000)))
        switch animate.kind {
        case .fade:
            return full
        case .typewriter:
            return State(characters: Int((Double(note.text.count) * progress).rounded(.up)), opacity: 1, drop: 0)
        case .slideUp:
            let eased = 1 - pow(1 - progress, 3)
            return State(characters: note.text.count, opacity: eased, drop: CGFloat(1 - eased) * 0.6)
        }
    }
}

/// The karaoke caption: the characters of a line up to the end of the last word that has started by a source time.
/// A word's start is the transcription's own (`segments[].words`) when it timed as many words as the line shows,
/// else it is estimated from where the word's letters sit in the line, as cut-words estimates (transcript-cuts.ts).
enum Karaoke {
    static func spokenCharacters(line: CaptionTrack.Line, atSourceUs us: Int64) -> Int {
        var words: [(start: Int, end: Int)] = []
        var open: Int?
        for (index, character) in line.text.enumerated() {
            if character.isWhitespace {
                if let start = open { words.append((start, index)) }
                open = nil
            } else if open == nil {
                open = index
            }
        }
        if let start = open { words.append((start, line.text.count)) }
        guard !words.isEmpty else { return 0 }
        let starts: [Int64]
        if line.wordStartsUs.count == words.count {
            starts = line.wordStartsUs
        } else {
            let length = Int64(max(1, line.text.count))
            starts = words.map { line.fromUs + (line.toUs - line.fromUs) * Int64($0.start) / length }
        }
        var spoken = 0
        for (word, startUs) in zip(words, starts) where startUs <= us { spoken = word.end }
        return spoken
    }
}

// R4 10 progress bar and chapter strip

/// What the progress bar draws on one output frame: the share played, where the chapters divide it, and the name of
/// a chapter that started less than `chapterMs` ago with its fade.
struct ProgressMark: Equatable {
    var share: Double
    var dividers: [Double]
    var color: String
    var height: Double
    var chapter: String?
    var chapterOpacity = 1.0

    static let fadeUs: Int64 = 200_000

    /// The markers (the recording's and the edit's) at their output times, inside the movie, in order; one per time.
    static func chapters(project: EditProject, recorded: [(us: Int64, label: String)]) -> [(outUs: Int64, label: String)] {
        let lengthUs = project.outputDurationUs
        let all = recorded + (project.markers ?? []).map { (us: $0.atUs, label: $0.label) }
        var seen = Set<Int64>()
        return all.compactMap { marker -> (outUs: Int64, label: String)? in
            guard let outUs = TimelineMap.outputTime(ofSource: marker.us, in: project), outUs >= 0, outUs < lengthUs else { return nil }
            return (outUs, marker.label)
        }
        .sorted { $0.outUs < $1.outUs }
        .filter { seen.insert($0.outUs).inserted }
    }

    static func at(outUs: Int64, project: EditProject, recorded: [(us: Int64, label: String)],
                   settings: EditProject.ProgressBar) -> ProgressMark? {
        let lengthUs = project.outputDurationUs
        guard settings.show, lengthUs > 0 else { return nil }
        let chapters = chapters(project: project, recorded: recorded)
        var mark = ProgressMark(share: min(1, max(0, Double(outUs) / Double(lengthUs))),
                                dividers: chapters.filter { $0.outUs > 0 }.map { Double($0.outUs) / Double(lengthUs) },
                                color: settings.color, height: settings.height)
        let showUs = Int64(settings.chapterMs) * 1000
        if settings.chapters, let current = chapters.last(where: { $0.outUs <= outUs }), outUs - current.outUs < showUs {
            let into = outUs - current.outUs
            mark.chapter = current.label
            mark.chapterOpacity = min(1, Double(into) / Double(fadeUs), Double(showUs - into) / Double(fadeUs))
        }
        return mark
    }
}

extension Looks {
    /// The bar along the bottom edge (a dim track, the played part in its colour, a dark gap at each chapter) and the
    /// starting chapter's name at the top left.
    static func drawProgress(_ mark: ProgressMark, plates: TextPlates, on image: CIImage, size: CGSize) -> CIImage {
        let unit = min(size.width, size.height)
        let barHeight = max(2, (mark.height * unit).rounded())
        let color = Looks.color(mark.color)
        let rect = { (x: CGFloat, width: CGFloat, ink: CIColor) in
            CIImage(color: ink).cropped(to: CGRect(x: x.rounded(), y: 0, width: max(1, width.rounded()), height: barHeight))
        }
        var result = rect(0, size.width, CIColor(red: color.red, green: color.green, blue: color.blue, alpha: 0.12)).composited(over: image)
        if mark.share > 0 {
            result = rect(0, size.width * mark.share, color).composited(over: result)
        }
        let gap = max(2, (barHeight * 0.6).rounded())
        for divider in mark.dividers {
            result = rect(size.width * divider - gap / 2, gap, CIColor(red: 0, green: 0, blue: 0, alpha: 0.9)).composited(over: result)
        }
        if let chapter = mark.chapter, mark.chapterOpacity > 0.01,
           var plate = plates.plate(chapter, fontSize: max(8, (unit * 0.034).rounded()), maxWidth: size.width * 0.5, weight: .semibold) {
            if mark.chapterOpacity < 0.999 {
                plate = plate.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(mark.chapterOpacity))])
            }
            let margin = (unit * 0.035).rounded()
            result = plate.transformed(by: CGAffineTransform(translationX: margin, y: size.height - margin - plate.extent.height))
                .composited(over: result)
        }
        return result
    }
}

// R4 9 intro and end cards

/// Where the export's cards sit: the intro's `leadUs` before the movie and the end card's `tailUs` after it. Off (the
/// preview) is zero for both, so the composition's time is the movie's.
struct CardSpans {
    enum Kind: Equatable {
        case intro(EditProject.IntroCard)
        case end(EditProject.EndCard)
    }

    /// One frame of a card: which, how far into it and how long it is.
    struct Frame: Equatable {
        var kind: Kind
        var sinceUs: Int64
        var lengthUs: Int64
    }

    let intro: EditProject.IntroCard?
    let end: EditProject.EndCard?

    init(project: EditProject, enabled: Bool) {
        intro = enabled ? project.cards?.intro : nil
        end = enabled ? project.cards?.end : nil
    }

    var leadUs: Int64 { intro.map { Int64(($0.seconds * 1_000_000).rounded()) } ?? 0 }
    var tailUs: Int64 { end.map { Int64(($0.seconds * 1_000_000).rounded()) } ?? 0 }

    /// The card at a movie output time (negative is the intro), or nil inside the movie.
    func card(atOutput outUs: Int64, movieUs: Int64) -> Frame? {
        if let intro, outUs < 0 {
            return Frame(kind: .intro(intro), sinceUs: outUs + leadUs, lengthUs: leadUs)
        }
        if let end, outUs >= movieUs {
            return Frame(kind: .end(end), sinceUs: outUs - movieUs, lengthUs: tailUs)
        }
        return nil
    }
}

extension Looks {
    static let cardFadeUs: Int64 = 400_000

    /// A card on the frame's background (its gradient, colour or picture; the default gradient without a frame): the
    /// intro's logo, title, subtitle and date, or the end card's text, link and QR code, centred, fading in and out.
    static func drawCard(_ card: CardSpans.Frame, project: EditProject, plates: TextPlates, size: CGSize) -> CIImage {
        var background = project.frame?.background ?? EditProject.Background()
        if background.kind == .none { background = EditProject.Background() }
        let canvas = Looks.background(background, size: size)
        let unit = min(size.width, size.height)
        var items: [CIImage] = []
        let text = { (words: String, share: CGFloat, weight: NSFont.Weight) -> CIImage? in
            plates.plate(words, fontSize: max(8, (unit * share).rounded()), maxWidth: size.width * 0.8, weight: weight, plain: true)
        }
        switch card.kind {
        case let .intro(intro):
            if let logo = intro.logo, let picture = BackgroundPictures.shared.image(logo) {
                let scale = min(unit * 0.2 / max(1, picture.extent.height), size.width * 0.4 / max(1, picture.extent.width))
                items.append(picture.transformed(by: CGAffineTransform(scaleX: scale, y: scale)))
            }
            items += [text(intro.title, 0.085, .bold), intro.subtitle.flatMap { text($0, 0.045, .medium) },
                      intro.date.flatMap { text($0, 0.032, .regular) }].compactMap { $0 }
        case let .end(end):
            items += [text(end.text, 0.07, .bold), end.link.flatMap { text($0, 0.036, .medium) }].compactMap { $0 }
            if end.qr, let link = end.link, let code = CardCodes.shared.qr(link, side: unit * 0.26) {
                items.append(code)
            }
        }
        let gap = unit * 0.025
        let total = items.reduce(0) { $0 + $1.extent.height } + gap * CGFloat(max(0, items.count - 1))
        var top = (size.height + total) / 2
        var content = CIImage.empty()
        for item in items {
            let x = ((size.width - item.extent.width) / 2 - item.extent.minX).rounded()
            let y = (top - item.extent.height - item.extent.minY).rounded()
            content = item.transformed(by: CGAffineTransform(translationX: x, y: y)).composited(over: content)
            top -= item.extent.height + gap
        }
        let fade = min(1, Double(card.sinceUs) / Double(cardFadeUs), Double(card.lengthUs - card.sinceUs) / Double(cardFadeUs))
        if fade < 0.999 {
            content = content.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(max(0, fade)))])
        }
        return content.composited(over: canvas).cropped(to: CGRect(origin: .zero, size: size))
    }
}

/// QR codes of the end card's link, made once per link and size: every frame of the card draws one.
final class CardCodes: @unchecked Sendable {
    static let shared = CardCodes()
    private let lock = NSLock()
    private var codes: [String: CIImage] = [:]

    /// Black modules on a white square with a quiet zone, `side` pixels wide, sharp (each module scaled whole).
    func qr(_ link: String, side: CGFloat) -> CIImage? {
        let key = "\(link)|\(Int(side))"
        lock.lock()
        defer { lock.unlock() }
        if let cached = codes[key] { return cached }
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(link.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let modules = filter.outputImage, modules.extent.width > 0 else { return nil }
        let quiet: CGFloat = 4
        let scale = max(1, (side / (modules.extent.width + quiet * 2)).rounded(.down))
        let code = modules.samplingNearest().transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let board = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: code.extent.width + quiet * 2 * scale,
                                                             height: code.extent.height + quiet * 2 * scale))
        let image = code.transformed(by: CGAffineTransform(translationX: quiet * scale, y: quiet * scale)).composited(over: board)
        codes[key] = image
        return image
    }
}
