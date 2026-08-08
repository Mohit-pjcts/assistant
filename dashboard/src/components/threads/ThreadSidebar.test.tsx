import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadSidebar } from "./ThreadSidebar";
import * as api from "@/lib/api";

// The persistent, Claude-style thread picker (Phase 15, extended) — lives
// in App.tsx alongside every tab, not scoped to History. See
// ThreadSidebar.tsx's module docstring for why full thread management
// moved here from the original History-tab-only design.

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchThreads: vi.fn(),
    createThread: vi.fn(),
    setActiveThread: vi.fn(),
    renameThread: vi.fn(),
    deleteThread: vi.fn(),
    fetchProjects: vi.fn(),
    createProject: vi.fn(),
    renameProject: vi.fn(),
    deleteProject: vi.fn(),
    assignThreadProject: vi.fn(),
  };
});

const mockedFetchThreads = vi.mocked(api.fetchThreads);
const mockedCreateThread = vi.mocked(api.createThread);
const mockedSetActiveThread = vi.mocked(api.setActiveThread);
const mockedRenameThread = vi.mocked(api.renameThread);
const mockedDeleteThread = vi.mocked(api.deleteThread);
const mockedFetchProjects = vi.mocked(api.fetchProjects);
const mockedCreateProject = vi.mocked(api.createProject);
const mockedRenameProject = vi.mocked(api.renameProject);
const mockedDeleteProject = vi.mocked(api.deleteProject);
const mockedAssignThreadProject = vi.mocked(api.assignThreadProject);

beforeEach(() => {
  vi.resetAllMocks();
  // Every pre-existing test in this file predates Projects entirely and
  // asserts on a flat thread list — defaulting to zero projects here
  // keeps every one of them rendering exactly as before without having
  // to touch each test individually.
  mockedFetchProjects.mockResolvedValue([]);
});

function renderSidebar() {
  const onActiveThreadChange = vi.fn();
  const utils = render(<ThreadSidebar onActiveThreadChange={onActiveThreadChange} />);
  return { onActiveThreadChange, ...utils };
}

describe("ThreadSidebar", () => {
  it("lists threads and highlights the active one, reporting it to the parent", async () => {
    mockedFetchThreads.mockResolvedValue({
      threads: [
        {
          id: "t1",
          title: "Trip planning",
          created_at: "x",
          last_active_at: "2026-07-15T00:00:00Z",
        },
        { id: "t2", title: null, created_at: "x", last_active_at: "2026-07-14T00:00:00Z" },
      ],
      activeThreadId: "t1",
    });

    const { onActiveThreadChange } = renderSidebar();

    const active = await screen.findByRole("button", { name: "Trip planning" });
    expect(active).toHaveAttribute("data-active", "true");
    const inactive = screen.getByRole("button", { name: "t2" });
    expect(inactive).toHaveAttribute("data-active", "false");
    await waitFor(() => expect(onActiveThreadChange).toHaveBeenCalledWith("t1"));
  });

  it("shows an empty state with no threads", async () => {
    mockedFetchThreads.mockResolvedValue({ threads: [], activeThreadId: "" });

    renderSidebar();

    expect(await screen.findByText(/no conversations yet/i)).toBeInTheDocument();
  });

  it("switches the active thread when a different one is clicked", async () => {
    const user = userEvent.setup();
    mockedFetchThreads.mockResolvedValue({
      threads: [
        { id: "t1", title: "Active thread", created_at: "x", last_active_at: "x" },
        { id: "t2", title: "Other thread", created_at: "x", last_active_at: "x" },
      ],
      activeThreadId: "t1",
    });
    mockedSetActiveThread.mockResolvedValue({
      id: "t2",
      title: "Other thread",
      created_at: "x",
      last_active_at: "x",
    });

    const { onActiveThreadChange } = renderSidebar();
    await screen.findByRole("button", { name: "Other thread" });

    await user.click(screen.getByRole("button", { name: "Other thread" }));

    await waitFor(() => expect(mockedSetActiveThread).toHaveBeenCalledWith("t2"));
    await waitFor(() => expect(onActiveThreadChange).toHaveBeenCalledWith("t2"));

    // Clicking the already-active thread must not re-trigger a switch.
    await user.click(screen.getByRole("button", { name: "Active thread" }));
    expect(mockedSetActiveThread).toHaveBeenCalledTimes(1);
  });

  it("creates a new chat via the New chat button", async () => {
    const user = userEvent.setup();
    mockedFetchThreads.mockResolvedValue({ threads: [], activeThreadId: "" });
    mockedCreateThread.mockResolvedValue({
      id: "new-1",
      title: null,
      created_at: "x",
      last_active_at: "x",
    });

    const { onActiveThreadChange } = renderSidebar();
    await waitFor(() => expect(mockedFetchThreads).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: /new chat/i }));

    await waitFor(() => expect(mockedCreateThread).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onActiveThreadChange).toHaveBeenCalledWith("new-1"));
    await waitFor(() => expect(mockedFetchThreads).toHaveBeenCalledTimes(2));
  });

  it("renames a thread via its rename control, submitting on Enter", async () => {
    const user = userEvent.setup();
    mockedFetchThreads.mockResolvedValue({
      threads: [{ id: "t1", title: "Old title", created_at: "x", last_active_at: "x" }],
      activeThreadId: "t1",
    });
    mockedRenameThread.mockResolvedValue({
      id: "t1",
      title: "New title",
      created_at: "x",
      last_active_at: "x",
    });

    renderSidebar();
    await screen.findByRole("button", { name: "Old title" });
    await user.click(screen.getByRole("button", { name: "Old title options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));

    const input = screen.getByTestId("thread-rename-input");
    await user.clear(input);
    await user.type(input, "New title{Enter}");

    await waitFor(() => expect(mockedRenameThread).toHaveBeenCalledWith("t1", "New title"));
  });

  it("renaming does not also switch the active thread", async () => {
    const user = userEvent.setup();
    mockedFetchThreads.mockResolvedValue({
      threads: [
        { id: "t1", title: "Active thread", created_at: "x", last_active_at: "x" },
        { id: "t2", title: "Other thread", created_at: "x", last_active_at: "x" },
      ],
      activeThreadId: "t1",
    });

    renderSidebar();
    await screen.findByRole("button", { name: "Other thread" });
    await user.click(screen.getByRole("button", { name: "Other thread options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));

    expect(screen.getByTestId("thread-rename-input")).toBeInTheDocument();
    expect(mockedSetActiveThread).not.toHaveBeenCalled();
  });

  it("requires confirmation before deleting — clicking Delete alone does not call the API", async () => {
    const user = userEvent.setup();
    mockedFetchThreads.mockResolvedValue({
      threads: [{ id: "t1", title: "To delete", created_at: "x", last_active_at: "x" }],
      activeThreadId: "t1",
    });

    renderSidebar();
    await screen.findByRole("button", { name: "To delete" });

    await user.click(screen.getByRole("button", { name: "To delete options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(mockedDeleteThread).not.toHaveBeenCalled();
  });

  it("cancelling the delete dialog does not delete the thread", async () => {
    const user = userEvent.setup();
    mockedFetchThreads.mockResolvedValue({
      threads: [{ id: "t1", title: "To keep", created_at: "x", last_active_at: "x" }],
      activeThreadId: "t1",
    });

    renderSidebar();
    await screen.findByRole("button", { name: "To keep" });
    await user.click(screen.getByRole("button", { name: "To keep options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    expect(mockedDeleteThread).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "To keep" })).toBeInTheDocument();
  });

  it("confirming the delete dialog deletes the thread and adopts the new active thread", async () => {
    const user = userEvent.setup();
    mockedFetchThreads.mockResolvedValue({
      threads: [{ id: "t1", title: "To delete", created_at: "x", last_active_at: "x" }],
      activeThreadId: "t1",
    });
    mockedDeleteThread.mockResolvedValue({ activeThreadId: "replacement-id" });

    const { onActiveThreadChange } = renderSidebar();
    await screen.findByRole("button", { name: "To delete" });
    await user.click(screen.getByRole("button", { name: "To delete options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(mockedDeleteThread).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(onActiveThreadChange).toHaveBeenCalledWith("replacement-id"));
  });

  it("shows an error if the thread list fails to load", async () => {
    mockedFetchThreads.mockRejectedValue(new Error("threads unavailable"));

    renderSidebar();

    expect(await screen.findByText(/threads unavailable/)).toBeInTheDocument();
  });

  describe("Projects (PLAN.md Phase 28)", () => {
    it("renders project folders with a thread count and ungrouped threads separately", async () => {
      mockedFetchProjects.mockResolvedValue([
        { id: "p1", name: "Coding", color: "#9b87f5", created_at: "x" },
      ]);
      mockedFetchThreads.mockResolvedValue({
        threads: [
          {
            id: "t1",
            title: "In the project",
            created_at: "x",
            last_active_at: "x",
            project_id: "p1",
          },
          { id: "t2", title: "No project", created_at: "x", last_active_at: "x", project_id: null },
        ],
        activeThreadId: "t1",
      });

      renderSidebar();

      const header = await screen.findByTestId("project-header");
      expect(within(header).getByText("Coding")).toBeInTheDocument();
      expect(within(header).getByText("1")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "In the project" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "No project" })).toBeInTheDocument();
    });

    it("collapsing a project hides its threads; expanding shows them again", async () => {
      const user = userEvent.setup();
      mockedFetchProjects.mockResolvedValue([
        { id: "p1", name: "Coding", color: "#9b87f5", created_at: "x" },
      ]);
      mockedFetchThreads.mockResolvedValue({
        threads: [
          {
            id: "t1",
            title: "Fix the bug",
            created_at: "x",
            last_active_at: "x",
            project_id: "p1",
          },
        ],
        activeThreadId: "t1",
      });

      renderSidebar();
      await screen.findByRole("button", { name: "Fix the bug" });

      await user.click(screen.getByTestId("project-header"));
      expect(screen.queryByRole("button", { name: "Fix the bug" })).not.toBeInTheDocument();

      await user.click(screen.getByTestId("project-header"));
      expect(screen.getByRole("button", { name: "Fix the bug" })).toBeInTheDocument();
    });

    it("creates a new project via the toolbar button, submitting on Enter", async () => {
      const user = userEvent.setup();
      mockedFetchThreads.mockResolvedValue({ threads: [], activeThreadId: "" });
      mockedCreateProject.mockResolvedValue({
        id: "p1",
        name: "Research",
        color: "#9b87f5",
        created_at: "x",
      });

      renderSidebar();
      await waitFor(() => expect(mockedFetchProjects).toHaveBeenCalledTimes(1));

      await user.click(screen.getByRole("button", { name: "New project" }));
      const input = screen.getByTestId("project-create-input");
      await user.type(input, "Research{Enter}");

      await waitFor(() => expect(mockedCreateProject).toHaveBeenCalledWith("Research"));
      await waitFor(() => expect(mockedFetchProjects).toHaveBeenCalledTimes(2));
    });

    it("renames a project via its rename control", async () => {
      const user = userEvent.setup();
      mockedFetchProjects.mockResolvedValue([
        { id: "p1", name: "Coding", color: "#9b87f5", created_at: "x" },
      ]);
      mockedFetchThreads.mockResolvedValue({ threads: [], activeThreadId: "" });
      mockedRenameProject.mockResolvedValue({
        id: "p1",
        name: "Engineering",
        color: "#9b87f5",
        created_at: "x",
      });

      renderSidebar();
      await screen.findByTestId("project-header");

      await user.click(screen.getByRole("button", { name: "Coding project options" }));
      await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
      const input = screen.getByTestId("project-rename-input");
      await user.clear(input);
      await user.type(input, "Engineering{Enter}");

      await waitFor(() => expect(mockedRenameProject).toHaveBeenCalledWith("p1", "Engineering"));
    });

    it("deleting a project requires confirmation, then calls deleteProject", async () => {
      const user = userEvent.setup();
      mockedFetchProjects.mockResolvedValue([
        { id: "p1", name: "Coding", color: "#9b87f5", created_at: "x" },
      ]);
      mockedFetchThreads.mockResolvedValue({ threads: [], activeThreadId: "" });

      renderSidebar();
      await screen.findByTestId("project-header");

      await user.click(screen.getByRole("button", { name: "Coding project options" }));
      await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(mockedDeleteProject).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));
      await waitFor(() => expect(mockedDeleteProject).toHaveBeenCalledWith("p1"));
    });

    it("moves a thread to a project via the 'Move to project' menu action", async () => {
      const user = userEvent.setup();
      mockedFetchProjects.mockResolvedValue([
        { id: "p1", name: "Coding", color: "#9b87f5", created_at: "x" },
      ]);
      mockedFetchThreads.mockResolvedValue({
        threads: [
          {
            id: "t1",
            title: "Fix the bug",
            created_at: "x",
            last_active_at: "x",
            project_id: null,
          },
        ],
        activeThreadId: "t1",
      });
      mockedAssignThreadProject.mockResolvedValue({
        id: "t1",
        title: "Fix the bug",
        created_at: "x",
        last_active_at: "x",
        project_id: "p1",
      });

      renderSidebar();
      await screen.findByRole("button", { name: "Fix the bug" });

      await user.click(screen.getByRole("button", { name: "Fix the bug options" }));
      await user.click(await screen.findByRole("menuitem", { name: "Coding" }));

      await waitFor(() => expect(mockedAssignThreadProject).toHaveBeenCalledWith("t1", "p1"));
    });

    it("clears a thread's project via the menu's 'No project' option", async () => {
      const user = userEvent.setup();
      mockedFetchProjects.mockResolvedValue([
        { id: "p1", name: "Coding", color: "#9b87f5", created_at: "x" },
      ]);
      mockedFetchThreads.mockResolvedValue({
        threads: [
          {
            id: "t1",
            title: "Fix the bug",
            created_at: "x",
            last_active_at: "x",
            project_id: "p1",
          },
        ],
        activeThreadId: "t1",
      });
      mockedAssignThreadProject.mockResolvedValue({
        id: "t1",
        title: "Fix the bug",
        created_at: "x",
        last_active_at: "x",
        project_id: null,
      });

      renderSidebar();
      await screen.findByRole("button", { name: "Fix the bug" });

      await user.click(screen.getByRole("button", { name: "Fix the bug options" }));
      await user.click(await screen.findByRole("menuitem", { name: "No project" }));

      await waitFor(() => expect(mockedAssignThreadProject).toHaveBeenCalledWith("t1", null));
    });

    it("moves a thread into a project via drag-and-drop", async () => {
      mockedFetchProjects.mockResolvedValue([
        { id: "p1", name: "Coding", color: "#9b87f5", created_at: "x" },
      ]);
      mockedFetchThreads.mockResolvedValue({
        threads: [
          {
            id: "t1",
            title: "Fix the bug",
            created_at: "x",
            last_active_at: "x",
            project_id: null,
          },
        ],
        activeThreadId: "t1",
      });
      mockedAssignThreadProject.mockResolvedValue({
        id: "t1",
        title: "Fix the bug",
        created_at: "x",
        last_active_at: "x",
        project_id: "p1",
      });

      renderSidebar();
      await screen.findByRole("button", { name: "Fix the bug" });

      const sourceRow = screen.getByTestId("thread-row-t1");
      const dropZone = screen.getByTestId("project-drop-zone-p1");
      fireEvent.dragStart(sourceRow);
      fireEvent.dragOver(dropZone);
      fireEvent.drop(dropZone);

      await waitFor(() => expect(mockedAssignThreadProject).toHaveBeenCalledWith("t1", "p1"));
    });

    it("moves a thread out of a project via drag-and-drop onto the ungrouped zone", async () => {
      mockedFetchProjects.mockResolvedValue([
        { id: "p1", name: "Coding", color: "#9b87f5", created_at: "x" },
      ]);
      mockedFetchThreads.mockResolvedValue({
        threads: [
          {
            id: "t1",
            title: "Fix the bug",
            created_at: "x",
            last_active_at: "x",
            project_id: "p1",
          },
        ],
        activeThreadId: "t1",
      });
      mockedAssignThreadProject.mockResolvedValue({
        id: "t1",
        title: "Fix the bug",
        created_at: "x",
        last_active_at: "x",
        project_id: null,
      });

      renderSidebar();
      await screen.findByRole("button", { name: "Fix the bug" });

      const sourceRow = screen.getByTestId("thread-row-t1");
      const dropZone = screen.getByTestId("ungrouped-drop-zone");
      fireEvent.dragStart(sourceRow);
      fireEvent.dragOver(dropZone);
      fireEvent.drop(dropZone);

      await waitFor(() => expect(mockedAssignThreadProject).toHaveBeenCalledWith("t1", null));
    });
  });
});
