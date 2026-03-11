import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { EmailPage } from "./EmailPage";

// Mock hooks
const mockInbox = {
  inbox: null as { email: string; autoReply: string | null; forwardToAgent: boolean } | null,
  isLoading: false,
  refresh: vi.fn(),
  checkUsername: vi.fn().mockResolvedValue(true),
  createInbox: vi.fn().mockResolvedValue(undefined),
  updateInbox: vi.fn().mockResolvedValue(undefined),
  deleteInbox: vi.fn().mockResolvedValue(undefined),
};

const mockMessages = {
  messages: [] as { id: string; direction: string; fromAddress: string; toAddress: string; subject: string | null; bodyText: string | null; bodyHtml: string | null; status: string; createdAt: string; threadId: string | null }[],
  isLoading: false,
  refresh: vi.fn(),
  markRead: vi.fn(),
  deleteMessage: vi.fn(),
  sendEmail: vi.fn(),
  replyToEmail: vi.fn(),
  fetchThread: vi.fn().mockResolvedValue([]),
};

const mockStats = { stats: null as { received: number; sent: number; unread: number } | null };

vi.mock("@/hooks/useEmail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useEmail")>();
  return {
    ...actual,
    useEmailInbox: () => mockInbox,
    useEmailMessages: () => mockMessages,
    useEmailStats: () => mockStats,
  };
});

let mockAuthenticated = true;
vi.mock("@/lib/authSession", () => ({
  startSession: vi.fn().mockResolvedValue(undefined),
  isAuthenticated: () => mockAuthenticated,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <EmailPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockAuthenticated = true;
  mockInbox.inbox = null;
  mockInbox.isLoading = false;
  mockMessages.messages = [];
  mockMessages.isLoading = false;
  mockStats.stats = null;
  vi.clearAllMocks();
});

describe("EmailPage", () => {
  describe("not authenticated", () => {
    it("shows connect screen with API key input", () => {
      mockAuthenticated = false;
      renderPage();
      expect(screen.getByText("Email")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("Agent API key")).toBeInTheDocument();
      expect(screen.getByText("Connect")).toBeInTheDocument();
    });
  });

  describe("authenticated, no inbox", () => {
    it("shows inbox setup form", () => {
      mockInbox.inbox = null;
      renderPage();
      expect(screen.getByText("Claim Your Email Address")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("your-agent")).toBeInTheDocument();
    });

    it("shows username availability after typing", async () => {
      mockInbox.inbox = null;
      renderPage();

      const input = screen.getByPlaceholderText("your-agent");
      fireEvent.change(input, { target: { value: "testbot" } });

      await waitFor(() => {
        expect(screen.getByText("Username is available")).toBeInTheDocument();
      }, { timeout: 1000 });
    });

    it("shows taken message when username unavailable", async () => {
      mockInbox.inbox = null;
      mockInbox.checkUsername.mockResolvedValueOnce(false);
      renderPage();

      const input = screen.getByPlaceholderText("your-agent");
      fireEvent.change(input, { target: { value: "taken-name" } });

      await waitFor(() => {
        expect(screen.getByText("Username is taken")).toBeInTheDocument();
      }, { timeout: 1000 });
    });

    it("disables create button until username is available", () => {
      mockInbox.inbox = null;
      renderPage();
      const btn = screen.getByText("Create Inbox (2.50 credits)");
      expect(btn).toBeDisabled();
    });
  });

  describe("authenticated with inbox", () => {
    beforeEach(() => {
      mockInbox.inbox = { email: "bot@ai.nookplot.com", autoReply: null, forwardToAgent: false };
      mockStats.stats = { received: 5, sent: 3, unread: 2 };
    });

    it("renders email header with address", () => {
      renderPage();
      expect(screen.getByText("bot@ai.nookplot.com")).toBeInTheDocument();
    });

    it("renders stats", () => {
      renderPage();
      expect(screen.getByText("5 received")).toBeInTheDocument();
      expect(screen.getByText("3 sent")).toBeInTheDocument();
      expect(screen.getByText("2 unread")).toBeInTheDocument();
    });

    it("renders filter tabs", () => {
      renderPage();
      expect(screen.getByText("All")).toBeInTheDocument();
      expect(screen.getByText("Inbox")).toBeInTheDocument();
      expect(screen.getByText("Sent")).toBeInTheDocument();
    });

    it("renders Compose button", () => {
      renderPage();
      expect(screen.getByText("Compose")).toBeInTheDocument();
    });

    it("shows empty inbox message when no messages", () => {
      renderPage();
      expect(screen.getByText("No emails yet")).toBeInTheDocument();
    });

    it("renders message rows", () => {
      mockMessages.messages = [
        {
          id: "m1",
          direction: "inbound",
          fromAddress: "alice@example.com",
          toAddress: "bot@ai.nookplot.com",
          subject: "Hello!",
          bodyText: "Hey there, how are you?",
          bodyHtml: null,
          status: "delivered",
          createdAt: new Date().toISOString(),
          threadId: null,
        },
      ];
      renderPage();
      expect(screen.getByText("Hello!")).toBeInTheDocument();
    });

    it("opens compose view when Compose is clicked", () => {
      renderPage();
      fireEvent.click(screen.getByText("Compose"));
      expect(screen.getByText("New Email")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("recipient@example.com")).toBeInTheDocument();
    });

    it("shows unread badge count", () => {
      renderPage();
      expect(screen.getByText("2")).toBeInTheDocument();
    });

    it("renders search input", () => {
      renderPage();
      expect(screen.getByPlaceholderText("Search emails")).toBeInTheDocument();
    });

    it("filters messages by search query", () => {
      mockMessages.messages = [
        {
          id: "m1",
          direction: "inbound",
          fromAddress: "alice@example.com",
          toAddress: "bot@ai.nookplot.com",
          subject: "Important notice",
          bodyText: "Please read",
          bodyHtml: null,
          status: "delivered",
          createdAt: new Date().toISOString(),
          threadId: null,
        },
        {
          id: "m2",
          direction: "outbound",
          fromAddress: "bot@ai.nookplot.com",
          toAddress: "bob@example.com",
          subject: "Reply to Bob",
          bodyText: "Thanks Bob",
          bodyHtml: null,
          status: "sent",
          createdAt: new Date().toISOString(),
          threadId: null,
        },
      ];
      renderPage();

      const searchInput = screen.getByPlaceholderText("Search emails");
      fireEvent.change(searchInput, { target: { value: "bob" } });

      // Should show only the message mentioning bob
      expect(screen.getByText("Reply to Bob")).toBeInTheDocument();
      expect(screen.queryByText("Important notice")).not.toBeInTheDocument();
    });

    it("shows Refresh button", () => {
      renderPage();
      expect(screen.getByText("Refresh")).toBeInTheDocument();
    });
  });
});
