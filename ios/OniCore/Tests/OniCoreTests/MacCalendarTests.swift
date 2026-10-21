import Foundation
import Testing
@testable import OniCore

@Suite struct MacCalendarTests {
    private func event(_ id: String, _ date: String, kind: String = "class", start: String? = nil, end: String? = nil,
                       until: String? = nil, title: String? = nil, course: String = "COMP2119") throws -> CalendarEvent {
        var object: [String: JSONValue] = ["id": .string(id), "date": .string(date), "kind": .string(kind),
                                           "title": .string(title ?? id), "course": .string(course)]
        if let start { object["start_time"] = .string(start) }
        if let end { object["end_time"] = .string(end) }
        if let until { object["end_date"] = .string(until) }
        return try CalendarEvent(.object(object))
    }

    @Test func theMacsCalendarJSONParses() throws {
        let json: JSONValue = [
            "events": [["id": "class:COMP2119:2026-09-01:13:00", "date": "2026-09-01", "title": "Data structures",
                        "course": "COMP2119", "kind": "class", "end_date": .null, "start_time": "13:00", "end_time": "14:50",
                        "location": "CYPP2", "weight": .null, "detail": .null, "note": .null, "tbc": false]],
            "courses": [["code": "COMP2119", "title": "Data structures"]],
            "undated": [["title": "x"], ["title": "y"]],
        ]
        let calendar = try MacCalendar(json)
        let e = try #require(calendar.events.first)
        #expect(e.timeRange == "13:00 – 14:50" && e.location == "CYPP2" && e.endDate == nil && !e.isDue)
        #expect(calendar.courses.map(\.code) == ["COMP2119"] && calendar.undatedCount == 2)
    }

    @Test func anEntryWithoutAnIdOrDateIsAnErrorNotASilentGap() {
        #expect(throws: (any Error).self) { try CalendarEvent(["date": "2026-09-01", "title": "x"]) }
        #expect(throws: (any Error).self) { try CalendarEvent(["id": "a", "title": "x"]) }
    }

    @Test func agendaDaysStartAtTodayAndSkipEmptyOnes() throws {
        let days = CalendarAgenda.days([
            try event("past", "2026-10-20"), try event("today", "2026-10-22"), try event("later", "2026-10-25"),
        ], from: "2026-10-22")
        #expect(days.map(\.date) == ["2026-10-22", "2026-10-25"])
    }

    @Test func dueEntriesComeFirstThenTimedByStartThenUntimed() throws {
        let day = try #require(CalendarAgenda.days([
            try event("c", "2026-10-22", start: "15:00"), try event("a", "2026-10-22", start: "09:00"),
            try event("notime", "2026-10-22", kind: "study"), try event("due", "2026-10-22", kind: "deadline"),
        ], from: "2026-10-22").first)
        #expect(day.events.map(\.id) == ["due", "a", "c", "notime"])
    }

    @Test func aWindowShowsOnEveryDayItCoversIncludingOneAlreadyUnderWay() throws {
        let window = try event("w", "2026-11-02", kind: "deadline", until: "2026-11-04")
        #expect(CalendarAgenda.days([window], from: "2026-10-30").map(\.date) == ["2026-11-02", "2026-11-03", "2026-11-04"])
        #expect(CalendarAgenda.days([window], from: "2026-11-03").map(\.date) == ["2026-11-03", "2026-11-04"])
        #expect(CalendarAgenda.days([window], from: "2026-11-05").isEmpty)
    }

    @Test func aWindowAcrossAMonthEndWalksTheCalendarCorrectly() throws {
        let window = try event("w", "2026-12-30", kind: "exam", until: "2027-01-02")
        #expect(CalendarAgenda.days([window], from: "2026-12-30").map(\.date) == ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"])
    }

    @Test func filtersMatchTheMacsToggles() throws {
        let all = [try event("c", "2026-10-22"), try event("t", "2026-10-22", kind: "tutorial"),
                   try event("s", "2026-10-22", kind: "study"), try event("e", "2026-10-22", kind: "exam"),
                   try event("d", "2026-10-22", kind: "deadline")]
        func ids(_ f: CalendarFilter) -> Set<String> { Set(CalendarAgenda.days(all, from: "2026-10-22", filter: f).flatMap(\.events).map(\.id)) }
        #expect(ids(.all) == ["c", "t", "s", "e", "d"])
        #expect(ids(.classes) == ["c"] && ids(.tutorials) == ["t"] && ids(.study) == ["s"])
        #expect(ids(.due) == ["e", "d"])
    }

    @Test func dateHelpersDoNotDependOnTheTimeZone() {
        #expect(CalendarAgenda.daysBetween("2026-10-22", "2026-10-23") == 1)
        #expect(CalendarAgenda.daysBetween("2026-10-22", "2026-10-20") == -2)
        #expect(CalendarAgenda.daysBetween("2026-12-31", "2027-01-01") == 1)
        #expect(CalendarAgenda.relativeName("2026-10-22", today: "2026-10-22") == "Today")
        #expect(CalendarAgenda.relativeName("2026-10-23", today: "2026-10-22") == "Tomorrow")
        #expect(CalendarAgenda.relativeName("2026-10-30", today: "2026-10-22") == nil)
        #expect(CalendarAgenda.addDays(1, to: "2026-02-28") == "2026-03-01")
        let utc8 = Calendar(identifier: .gregorian).withTimeZone("Asia/Hong_Kong")
        let noon = CalendarAgenda.date("2026-10-22", calendar: utc8)
        #expect(noon.map { CalendarAgenda.iso($0, calendar: utc8) } == "2026-10-22")
    }

    @Test func aCourseKeepsItsColourAndNeighboursDiffer() {
        let courses = ["COMP2119", "AILT9009", "MATH2014", "CCHU9053"]
        let hues = courses.map { CalendarAgenda.hue(for: $0, among: courses) }
        #expect(Set(hues).count == 4)
        #expect(CalendarAgenda.hue(for: "MATH2014", among: courses) == CalendarAgenda.hue(for: "MATH2014", among: courses.reversed()))
        #expect(hues.allSatisfy { (0..<1).contains($0) })
    }
}

private extension Calendar {
    func withTimeZone(_ id: String) -> Calendar {
        var copy = self
        copy.timeZone = TimeZone(identifier: id)!
        return copy
    }
}
