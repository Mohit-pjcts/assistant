import Foundation

/// One entry of the semester calendar the Mac builds from the Vault's notes
/// (assistant/calendar_store.py). Read-only on the phone.
public struct CalendarEvent: Sendable, Equatable, Identifiable {
    public let id: String
    /// ISO start date, `yyyy-MM-dd`. Plain strings sort correctly, so dates are
    /// compared as text and no time zone can shift an event onto another day.
    public let date: String
    /// Set for a window that runs over several days (inclusive).
    public let endDate: String?
    public let title: String
    public let course: String
    public let kind: String
    public let startTime: String?
    public let endTime: String?
    public let location: String?
    public let weight: String?
    public let detail: String?
    public let note: String?
    /// A real session whose time or room is not in the Vault yet.
    public let toBeConfirmed: Bool

    init(_ json: JSONValue) throws {
        id = try json.requireString("id", in: "calendar event")
        date = try json.requireString("date", in: "calendar event")
        title = try json.requireString("title", in: "calendar event")
        kind = json["kind"]?.string ?? "class"
        course = json["course"]?.string ?? ""
        endDate = json["end_date"]?.string
        startTime = json["start_time"]?.string
        endTime = json["end_time"]?.string
        location = json["location"]?.string
        weight = json["weight"]?.string
        detail = json["detail"]?.string
        note = json["note"]?.string
        toBeConfirmed = json["tbc"]?.bool ?? false
    }

    /// Exams and deadlines: the entries the view answers "what's due" with.
    public var isDue: Bool { kind == "exam" || kind == "deadline" }

    /// The last day this entry covers.
    public var lastDate: String { max(date, endDate ?? date) }

    /// "13:00 – 14:50", "13:00", or nil when no time is stated.
    public var timeRange: String? {
        switch (startTime, endTime) {
        case let (start?, end?): "\(start) – \(end)"
        case let (start?, nil): start
        default: nil
        }
    }
}

public struct MacCalendar: Sendable, Equatable {
    public let events: [CalendarEvent]
    /// Course codes and names, as the Vault lists them.
    public let courses: [(code: String, title: String)]
    public let undatedCount: Int

    public init(_ json: JSONValue) throws {
        events = try (json["events"]?.array ?? []).map(CalendarEvent.init)
        courses = (json["courses"]?.array ?? []).compactMap {
            guard let code = $0["code"]?.string else { return nil }
            return (code, $0["title"]?.string ?? "")
        }
        undatedCount = json["undated"]?.array?.count ?? 0
    }

    public static func == (lhs: MacCalendar, rhs: MacCalendar) -> Bool {
        lhs.events == rhs.events && lhs.undatedCount == rhs.undatedCount
            && lhs.courses.map(\.code) == rhs.courses.map(\.code)
    }

    init(events: [CalendarEvent]) {
        self.events = events
        courses = []
        undatedCount = 0
    }
}

/// One day of the agenda.
public struct AgendaDay: Sendable, Equatable, Identifiable {
    public var id: String { date }
    public let date: String
    public let events: [CalendarEvent]
}

/// Which entries the Calendar screen shows (the Mac's four toggles).
public enum CalendarFilter: String, CaseIterable, Sendable {
    case all = "Everything"
    case classes = "Classes"
    case tutorials = "Tutorials"
    case study = "Study"
    case due = "Deadlines & exams"

    public func includes(_ event: CalendarEvent) -> Bool {
        switch self {
        case .all: true
        case .classes: event.kind == "class"
        case .tutorials: event.kind == "tutorial"
        case .study: event.kind == "study"
        case .due: event.isDue
        }
    }
}

/// The pure logic behind the Calendar screen: grouping into days, ordering,
/// dates, and a stable colour per course.
public enum CalendarAgenda {
    /// The days from `from` onward that have something on them. A window that
    /// runs over several days appears on every day it covers, so a deadline
    /// window is still visible in the middle of it.
    public static func days(_ events: [CalendarEvent], from: String, filter: CalendarFilter = .all) -> [AgendaDay] {
        let wanted = events.filter { filter.includes($0) && $0.lastDate >= from }
        var byDay: [String: [CalendarEvent]] = [:]
        for event in wanted {
            // A window already under way starts being shown today, not on its first day.
            var day = max(event.date, from)
            while day <= event.lastDate {
                byDay[day, default: []].append(event)
                guard let next = addDays(1, to: day) else { break }
                day = next
            }
        }
        return byDay.keys.sorted().map { AgendaDay(date: $0, events: ordered(byDay[$0] ?? [])) }
    }

    /// Exams and deadlines first (the things that matter most on a day), then
    /// by start time, entries without a time last, then by title.
    static func ordered(_ events: [CalendarEvent]) -> [CalendarEvent] {
        events.sorted { a, b in
            if a.isDue != b.isDue { return a.isDue }
            switch (a.startTime, b.startTime) {
            case let (x?, y?) where x != y: return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return a.title < b.title
            }
        }
    }

    public static func iso(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    public static func date(_ iso: String, calendar: Calendar = .current) -> Date? {
        let parts = iso.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }

    static func addDays(_ n: Int, to iso: String) -> String? {
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = TimeZone(identifier: "UTC")!
        guard let start = date(iso, calendar: gregorian), let end = gregorian.date(byAdding: .day, value: n, to: start) else { return nil }
        return Self.iso(end, calendar: gregorian)
    }

    /// Whole days from `from` to `to` (negative if `to` is earlier).
    public static func daysBetween(_ from: String, _ to: String) -> Int {
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = TimeZone(identifier: "UTC")!
        guard let a = date(from, calendar: gregorian), let b = date(to, calendar: gregorian) else { return 0 }
        return gregorian.dateComponents([.day], from: a, to: b).day ?? 0
    }

    /// "Today", "Tomorrow", "Yesterday", or nil for any other day.
    public static func relativeName(_ day: String, today: String) -> String? {
        switch daysBetween(today, day) {
        case 0: "Today"
        case 1: "Tomorrow"
        case -1: "Yesterday"
        default: nil
        }
    }

    /// A hue in 0...1 for a course: the n-th course gets the n-th step round the
    /// colour wheel by the golden angle, so neighbours differ clearly and a course
    /// keeps its colour as long as the list of courses does not change.
    public static func hue(for course: String, among courses: [String]) -> Double {
        let order = Array(Set(courses + [course])).sorted()
        let index = order.firstIndex(of: course) ?? 0
        return (Double(index) * 0.618_033_988_75).truncatingRemainder(dividingBy: 1)
    }
}
