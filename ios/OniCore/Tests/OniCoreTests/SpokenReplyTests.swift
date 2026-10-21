import Testing
@testable import OniCore

/// Reply text cut into pieces so the voice can start on the first while the rest is made.
@Suite struct SpokenReplyTests {
    @Test func aShortReplyIsOnePiece() {
        let result = SpokenReply.pieces("Your next meeting is at three.")
        #expect(result.pieces == ["Your next meeting is at three."])
        #expect(!result.truncated)
    }

    @Test func theFirstPieceKeepsGrowingUntilItIsWorthARequest() {
        let result = SpokenReply.pieces("Sure. Okay. Your next meeting is at three with the design team. Then lunch.")
        #expect(result.pieces[0] == "Sure. Okay. Your next meeting is at three with the design team.")
        #expect(result.pieces[0].count >= SpokenReply.firstMinimum)
        #expect(result.pieces[1] == "Then lunch.")
    }

    @Test func laterSentencesAreGroupedUpToThePieceLimit() {
        let sentence = "This is one fairly ordinary sentence of about this length."
        let text = Array(repeating: sentence, count: 8).joined(separator: " ")
        let result = SpokenReply.pieces(text)
        #expect(result.pieces.count >= 2)
        for piece in result.pieces.dropFirst() { #expect(piece.count <= SpokenReply.maxPiece) }
        #expect(!result.truncated)
    }

    @Test func aReplyPastTheTotalCapIsCutAndSaysSo() {
        let sentence = "This is one fairly ordinary sentence of about this length."
        let result = SpokenReply.pieces(Array(repeating: sentence, count: 40).joined(separator: " "))
        #expect(result.truncated)
        #expect(result.pieces.joined(separator: " ").count <= SpokenReply.maxTotal)
        #expect(result.pieces.joined(separator: " ").hasSuffix("length."))   // cut between sentences
    }

    @Test func oneEnormousSentenceIsSplitOnWordsNotMidWord() {
        let result = SpokenReply.pieces(Array(repeating: "word", count: 120).joined(separator: " ") + ".")
        for piece in result.pieces { #expect(piece.count <= SpokenReply.maxPiece + 1); #expect(!piece.hasPrefix(" ")) }
        #expect(result.pieces.count >= 2)
    }

    @Test func nothingToSayIsNoPieces() {
        #expect(SpokenReply.pieces("  \n ").pieces.isEmpty)
    }
}
