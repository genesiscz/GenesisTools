import Foundation

/// Client-side mirror of the QA pending-form rules the server enforces regardless
/// (`sanitizeFileTags`/`sanitizeImages`, `src/question/lib/pending/form.ts`, and the caps in
/// `src/question/lib/pending/types.ts`). Kept here, pure and testable, so the Hub's file-tag field
/// and image picker can give inline feedback instead of only finding out from a rejected submit.
enum QaFormFields {
    /// `MAX_IMAGES_PER_ANSWER` (`src/question/lib/pending/types.ts`).
    static let maxImagesPerAnswer = 4
    /// `MAX_IMAGE_BASE64_CHARS` (2,000,000) expressed as raw bytes: base64 inflates 3 bytes to 4
    /// chars, so this is the largest PNG the server will keep once encoded.
    static let maxImageBytes = 1_500_000
    /// `MAX_FILE_TAGS_PER_ANSWER` (`src/question/lib/pending/types.ts`).
    static let maxFileTagsPerAnswer = 20

    /// Splits a manual `@file` field the way the dashboard does (`splitTags`,
    /// `QaPendingCard.tsx`): space or comma separated, a leading `@` stripped, blanks dropped.
    static func splitFileTags(_ raw: String) -> [String] {
        raw.split(whereSeparator: { $0 == " " || $0 == "," || $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .map { $0.hasPrefix("@") ? String($0.dropFirst()) : $0 }
    }

    /// A path picked from `NSOpenPanel`, made relative to the form's cwd; nil when the file is
    /// outside it (`sanitizeFileTags` also refuses this server-side, but a browse picker that
    /// lets you choose an out-of-bounds file and only finds out on submit is a worse experience
    /// than refusing at the picker).
    static func relativeFileTag(_ path: String, cwd: String) -> String? {
        let root = (cwd as NSString).standardizingPath
        let full = (path as NSString).standardizingPath

        guard full == root || full.hasPrefix(root + "/") else {
            return nil
        }

        let relative = String(full.dropFirst(root.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        return relative.isEmpty ? nil : relative
    }
}
