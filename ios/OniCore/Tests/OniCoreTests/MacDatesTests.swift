import Foundation
import Testing
@testable import OniCore

@Suite struct MacDatesTests {
    @Test func readsPythonsIsoformatWithMicroseconds() throws {
        let date = try #require(MacDates.parse("2026-10-21T06:43:50.038181+00:00"))
        #expect(abs(date.timeIntervalSince1970 - 1_792_565_030.038) < 1)
    }

    @Test func readsTheFormWithoutAFraction() throws {
        #expect(MacDates.parse("2026-10-21T06:43:50+00:00") == MacDates.parse("2026-10-21T06:43:50.000000+00:00"))
        #expect(try #require(MacDates.parse("2026-10-21T06:43:50Z")) == MacDates.parse("2026-10-21T06:43:50+00:00"))
    }

    @Test func aNumericOffsetMovesTheInstant() throws {
        let utc = try #require(MacDates.parse("2026-10-21T06:00:00+00:00"))
        let hk = try #require(MacDates.parse("2026-10-21T14:00:00+08:00"))
        #expect(utc == hk)
    }

    @Test func garbageIsNilNotToday() {
        #expect(MacDates.parse("") == nil)
        #expect(MacDates.parse("yesterday") == nil)
    }
}
