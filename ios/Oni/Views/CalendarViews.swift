import OniCore
import SwiftUI

/// The semester calendar the Mac builds from the Vault's notes, as an agenda:
/// the days from today with something on them. Read-only here; edits are made
/// on the Mac.
struct CalendarView: View {
    @Environment(MacController.self) private var mac
    @State private var calendar: MacCalendar?
    @State private var failure: String?
    @State private var filter: CalendarFilter = .all
    @State private var start = Date()
    @State private var picking = false

    private var today: String { CalendarAgenda.iso(Date()) }
    private var from: String { CalendarAgenda.iso(start) }

    var body: some View {
        Group {
            if let calendar {
                agenda(calendar)
            } else if let failure {
                ContentUnavailableView {
                    Label("Can't load the calendar", systemImage: "wifi.exclamationmark")
                } description: {
                    Text("\(failure)\nCheck that Tailscale is on and the Mac is awake.")
                } actions: {
                    Button("Try again") { Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Calendar")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Picker("Show", selection: $filter) {
                        ForEach(CalendarFilter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    Divider()
                    Button("Jump to a date…", systemImage: "calendar.badge.clock") { picking = true }
                    if from != today {
                        Button("Back to today", systemImage: "arrow.uturn.backward") { start = Date() }
                    }
                } label: {
                    Image(systemName: filter == .all ? "ellipsis.circle" : "line.3.horizontal.decrease.circle.fill")
                }
                .accessibilityLabel("Calendar options")
            }
        }
        .sheet(isPresented: $picking) { datePicker }
        .task { await load() }
    }

    // MARK: agenda

    @ViewBuilder private func agenda(_ calendar: MacCalendar) -> some View {
        let days = CalendarAgenda.days(calendar.events, from: from, filter: filter)
        let codes = calendar.courses.map(\.code)
        List {
            if from != today {
                Section {
                    Button("Showing from \(label(from)). Back to today") { start = Date() }
                        .font(.footnote)
                }
            }
            if days.isEmpty {
                ContentUnavailableView(
                    filter == .all ? "Nothing coming up" : "Nothing matches",
                    systemImage: "calendar",
                    description: Text(filter == .all ? "No classes, deadlines or exams from this date on." : "Try another filter from the menu."))
                    .listRowBackground(Color.clear)
            }
            ForEach(days) { day in
                Section {
                    ForEach(day.events) { EventRow(event: $0, day: day.date, codes: codes) }
                } header: {
                    DayHeader(date: day.date, today: today)
                }
            }
            if calendar.undatedCount > 0 {
                Section {
                    Text("\(calendar.undatedCount) item\(calendar.undatedCount == 1 ? "" : "s") in the Vault have no date yet.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .refreshable { await load() }
    }

    private var datePicker: some View {
        NavigationStack {
            DatePicker("Start from", selection: $start, displayedComponents: .date)
                .datePickerStyle(.graphical)
                .padding()
                .navigationTitle("Jump to a date")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { picking = false } }
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Today") { start = Date(); picking = false }
                    }
                }
        }
        .presentationDetents([.medium])
    }

    private func label(_ iso: String) -> String {
        CalendarAgenda.date(iso)?.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)) ?? iso
    }

    private func load() async {
        guard let server = mac.server else {
            failure = "Pair with your Mac first (Settings)."
            return
        }
        do {
            calendar = try await server.calendar()
            failure = nil
        } catch {
            // Keep what is already shown if a refresh fails.
            if calendar == nil { failure = (error as? MacServerError)?.description ?? error.localizedDescription }
        }
    }
}

private struct DayHeader: View {
    let date: String
    let today: String

    var body: some View {
        HStack(spacing: 6) {
            if let name = CalendarAgenda.relativeName(date, today: today) {
                Text(name).fontWeight(.semibold).foregroundStyle(name == "Today" ? Color.accentColor : .primary)
                Text("·").foregroundStyle(.secondary)
            }
            Text(CalendarAgenda.date(date)?.formatted(.dateTime.weekday(.wide).day().month(.abbreviated)) ?? date)
                .foregroundStyle(.secondary)
        }
        .font(.subheadline)
        .textCase(nil)
    }
}

private struct EventRow: View {
    let event: CalendarEvent
    let day: String
    let codes: [String]

    private var tint: Color {
        Color(hue: CalendarAgenda.hue(for: event.course, among: codes), saturation: 0.55, brightness: 0.92)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            timeColumn.frame(width: 46, alignment: .trailing)
            RoundedRectangle(cornerRadius: 2).fill(tint).frame(width: 4)
            VStack(alignment: .leading, spacing: 3) {
                Text(event.title).font(.body).fontWeight(event.isDue ? .semibold : .regular)
                if let place = event.location {
                    Label(place, systemImage: "mappin.and.ellipse").font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    if !event.course.isEmpty { Text(event.course) }
                    Text(kindName)
                    if let weight = event.weight { Text("· \(weight)") }
                }
                .font(.caption).foregroundStyle(.secondary)
                if let until = continuation { Text(until).font(.caption).foregroundStyle(.orange) }
                if event.toBeConfirmed {
                    Text("Time or room to be confirmed").font(.caption).foregroundStyle(.orange)
                } else if let note = event.note {
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var timeColumn: some View {
        if let start = event.startTime {
            VStack(alignment: .trailing, spacing: 1) {
                Text(start).font(.subheadline.monospacedDigit()).fontWeight(.semibold)
                if let end = event.endTime { Text(end).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
            }
        } else {
            Image(systemName: event.isDue ? "flag.fill" : "clock")
                .font(.footnote).foregroundStyle(event.isDue ? Color.orange : .secondary)
        }
    }

    private var kindName: String {
        switch event.kind {
        case "class": "Class"
        case "tutorial": "Tutorial"
        case "study": "Study"
        case "exam": "Exam"
        case "deadline": "Deadline"
        default: event.kind.capitalized
        }
    }

    /// For a window that runs over several days, when it ends.
    private var continuation: String? {
        guard let end = event.endDate, end > event.date else { return nil }
        let name = CalendarAgenda.date(end)?.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)) ?? end
        return day == end ? "Last day of the window" : "Until \(name)"
    }
}
