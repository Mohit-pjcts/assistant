import OniCore
import SwiftUI

/// The Mac's kanban board (PLAN.md Phase 31 D9). One column at a time on a
/// phone: pick the column, then move a task with its menu or a swipe. Every
/// change is made on the Mac first and shown once it accepts.
struct MacBoardView: View {
    @Environment(MacController.self) private var mac
    @State private var column: BoardColumn = .todo
    @State private var editing: BoardTask?
    @State private var adding = false

    private static let titles: [BoardColumn: String] = [
        .todo: "To-do", .inProgress: "In progress", .inReview: "In review", .done: "Done",
    ]

    var body: some View {
        Group {
            if let board = mac.board {
                content(board)
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Board")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard let extras = mac.prepareExtras() else { return }
            await extras.board.load()
        }
    }

    private func content(_ board: MacBoard) -> some View {
        VStack(spacing: 0) {
            Picker("Column", selection: $column) {
                ForEach(BoardColumn.allCases, id: \.self) { c in
                    Text("\(Self.titles[c] ?? c.rawValue) \(board.tasks(in: c).count)").tag(c)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16).padding(.vertical, 8)

            if let error = board.errorMessage {
                HStack(alignment: .top) {
                    Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button { board.dismissError() } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 16).padding(.bottom, 6)
            }

            let tasks = board.tasks(in: column)
            List {
                if tasks.isEmpty, board.isLoaded {
                    ContentUnavailableView("Nothing in \(Self.titles[column] ?? "this column")", systemImage: "tray")
                        .listRowBackground(Color.clear)
                }
                ForEach(tasks) { task in
                    TaskRow(task: task)
                        .contentShape(Rectangle())
                        .onTapGesture { editing = task }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { Task { await board.delete(task) } } label: { Label("Delete", systemImage: "trash") }
                        }
                        .contextMenu {
                            ForEach(BoardColumn.allCases.filter { $0 != task.column }, id: \.self) { target in
                                Button { Task { await board.move(task, to: target) } } label: {
                                    Label("Move to \(Self.titles[target] ?? target.rawValue)", systemImage: "arrow.right")
                                }
                            }
                        }
                }
            }
            .listStyle(.plain)
            .refreshable { await board.load() }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { adding = true } label: { Image(systemName: "plus") }.accessibilityLabel("New task")
            }
        }
        .disabled(board.isWorking)
        .sheet(isPresented: $adding) {
            TaskEditor(task: nil, column: column) { title, description, priority, target in
                await board.add(title: title, description: description, priority: priority, column: target)
            }
        }
        .sheet(item: $editing) { task in
            TaskEditor(task: task, column: task.column,
                       move: { target in await board.move(task, to: target) }) { title, description, priority, _ in
                await board.edit(task, title: title, description: description, priority: priority)
            }
        }
    }
}

private struct TaskRow: View {
    let task: BoardTask

    private var priorityColor: Color {
        switch task.priority {
        case "high": .red
        case "low": .teal
        default: .orange
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(task.ref).font(.caption).foregroundStyle(.secondary)
                Circle().fill(priorityColor).frame(width: 7, height: 7)
                Text(task.priority.capitalized).font(.caption).foregroundStyle(.secondary)
            }
            Text(task.title).font(.headline)
            if !task.description.isEmpty {
                Text(task.description).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
    }
}

/// New task, or an existing one (title, description, priority, and which column).
private struct TaskEditor: View {
    let task: BoardTask?
    let column: BoardColumn
    var move: ((BoardColumn) async -> Bool)?
    let save: (String, String, String, BoardColumn) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var description: String
    @State private var priority: String
    @State private var target: BoardColumn
    @State private var saving = false

    init(task: BoardTask?, column: BoardColumn, move: ((BoardColumn) async -> Bool)? = nil,
         save: @escaping (String, String, String, BoardColumn) async -> Bool) {
        self.task = task
        self.column = column
        self.move = move
        self.save = save
        _title = State(initialValue: task?.title ?? "")
        _description = State(initialValue: task?.description ?? "")
        _priority = State(initialValue: task?.priority ?? "medium")
        _target = State(initialValue: column)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Title") { TextField("What needs doing", text: $title, axis: .vertical) }
                Section("Details") { TextField("Optional", text: $description, axis: .vertical).lineLimit(2...8) }
                Section {
                    Picker("Priority", selection: $priority) {
                        Text("Low").tag("low"); Text("Medium").tag("medium"); Text("High").tag("high")
                    }
                    .pickerStyle(.segmented)
                    Picker("Column", selection: $target) {
                        Text("To-do").tag(BoardColumn.todo); Text("In progress").tag(BoardColumn.inProgress)
                        Text("In review").tag(BoardColumn.inReview); Text("Done").tag(BoardColumn.done)
                    }
                }
            }
            .navigationTitle(task == nil ? "New task" : task!.ref)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saving = true
                        Task {
                            var ok = await save(title, description, priority, target)
                            if ok, let move, target != column { ok = await move(target) }
                            saving = false
                            if ok { dismiss() }
                        }
                    }
                    .disabled(saving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.large])
    }
}

// MARK: - Memory approvals

/// Facts Oni's nightly review wants to remember. Nothing is remembered until
/// one is approved here or on the dashboard. The fact is shown in full.
struct MacMemoryView: View {
    @Environment(MacController.self) private var mac

    var body: some View {
        Group {
            if let review = mac.review { content(review) } else { ProgressView() }
        }
        .navigationTitle("Memory to review")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard let extras = mac.prepareExtras() else { return }
            await extras.review.load()
        }
    }

    private func content(_ review: MacMemoryReview) -> some View {
        List {
            if let error = review.errorMessage {
                HStack(alignment: .top) {
                    Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button { review.dismissError() } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            if review.pending.isEmpty, review.isLoaded {
                ContentUnavailableView(
                    "Nothing to review", systemImage: "checkmark.circle",
                    description: Text("Oni looks back over your conversations once a day and suggests things worth remembering."))
                    .listRowBackground(Color.clear)
            }
            ForEach(review.pending) { fact in
                VStack(alignment: .leading, spacing: 8) {
                    Text(fact.content).font(.body).textSelection(.enabled)
                    if let source = fact.provenance, !source.isEmpty {
                        Text(source).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    HStack {
                        Button("Decline", role: .destructive) { Task { await review.decline(fact) } }
                            .buttonStyle(.bordered)
                        Button("Approve") { Task { await review.approve(fact) } }
                            .buttonStyle(.borderedProminent)
                        if review.answering.contains(fact.id) { ProgressView().controlSize(.small) }
                    }
                    .disabled(review.answering.contains(fact.id))
                }
                .padding(.vertical, 4)
            }
        }
        .refreshable { await review.load() }
    }
}
