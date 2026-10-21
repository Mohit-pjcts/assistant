import Foundation

/// Cuts a reply into pieces for the voice, so the first piece can start playing
/// while the later ones are still being made (a short sentence comes back from
/// ElevenLabs in about 1-2 s, a long one takes longer).
public enum SpokenReply {
    /// The first piece is at least this long (a lone "Sure." is a wasted request).
    public static let firstMinimum = 40
    public static let maxPiece = 300
    /// Everything past this is not spoken. The Mac enforces the same cap per request.
    public static let maxTotal = 700

    /// The pieces to speak, in order, and whether the reply was cut short.
    public static func pieces(_ text: String) -> (pieces: [String], truncated: Bool) {
        var sentences: [String] = []
        text.enumerateSubstrings(in: text.startIndex..., options: [.bySentences, .substringNotRequired]) { _, range, _, _ in
            let sentence = text[range].trimmingCharacters(in: .whitespacesAndNewlines)
            if !sentence.isEmpty { sentences.append(sentence) }
        }
        var pieces: [String] = []
        var current = ""
        var total = 0
        var truncated = false
        for sentence in sentences.flatMap(split) {
            if total + sentence.count > maxTotal {
                truncated = true
                break
            }
            total += sentence.count + 1
            if current.isEmpty {
                current = sentence
            } else if current.count + 1 + sentence.count <= maxPiece {
                current += " " + sentence
            } else {
                pieces.append(current)
                current = sentence
            }
            // The first piece goes out as soon as it is long enough to be worth a request.
            if pieces.isEmpty, current.count >= firstMinimum {
                pieces.append(current)
                current = ""
            }
        }
        if !current.isEmpty { pieces.append(current) }
        return (pieces, truncated)
    }

    /// A sentence longer than a piece is cut on word boundaries.
    private static func split(_ sentence: String) -> [String] {
        guard sentence.count > maxPiece else { return [sentence] }
        var parts: [String] = []
        var line = ""
        for word in sentence.split(separator: " ") {
            if !line.isEmpty, line.count + 1 + word.count > maxPiece {
                parts.append(line)
                line = String(word)
            } else {
                line += (line.isEmpty ? "" : " ") + word
            }
        }
        if !line.isEmpty { parts.append(line) }
        return parts
    }
}
