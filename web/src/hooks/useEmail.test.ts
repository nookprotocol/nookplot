import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useEmailInbox, useEmailMessages, useEmailStats } from "./useEmail";

// ============================================================
//  Mock gatewayFetch
// ============================================================

const mockGatewayFetch = vi.fn();
vi.mock("@/lib/gateway", () => ({
  gatewayFetch: (...args: unknown[]) => mockGatewayFetch(...args),
}));

beforeEach(() => {
  mockGatewayFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
//  Fixtures
// ============================================================

const MOCK_INBOX = {
  id: "inbox-1",
  agentId: "agent-1",
  username: "test-agent",
  email: "test-agent@ai.nookplot.com",
  displayName: "Test Agent",
  autoReply: null,
  forwardToAgent: false,
  status: "active",
  createdAt: "2025-01-01T00:00:00Z",
};

const MOCK_MESSAGE = {
  id: "msg-1",
  inboxId: "inbox-1",
  direction: "inbound" as const,
  fromAddress: "human@example.com",
  toAddress: "test-agent@ai.nookplot.com",
  subject: "Hello",
  bodyText: "Hi there!",
  bodyHtml: null,
  status: "delivered",
  threadId: "thread-1",
  inReplyTo: null,
  sesMessageId: null,
  createdAt: "2025-01-02T00:00:00Z",
};

const MOCK_STATS = { total: 10, sent: 3, received: 7, unread: 2 };

// ============================================================
//  useEmailInbox
// ============================================================

describe("useEmailInbox", () => {
  it("returns null inbox when no apiKey", () => {
    const { result } = renderHook(() => useEmailInbox(null));
    expect(result.current.inbox).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("fetches inbox on mount when apiKey is provided", async () => {
    mockGatewayFetch.mockResolvedValueOnce(MOCK_INBOX);
    const { result } = renderHook(() => useEmailInbox("session"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.inbox).toEqual(MOCK_INBOX);
    expect(mockGatewayFetch).toHaveBeenCalledWith("/v1/email/inbox", "session");
  });

  it("sets inbox to null when fetch fails (no inbox)", async () => {
    mockGatewayFetch.mockRejectedValueOnce(new Error("404: not found"));
    const { result } = renderHook(() => useEmailInbox("session"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.inbox).toBeNull();
  });

  it("checkUsername returns true when available", async () => {
    mockGatewayFetch
      .mockResolvedValueOnce(MOCK_INBOX) // initial fetch
      .mockResolvedValueOnce({ available: true }); // checkUsername

    const { result } = renderHook(() => useEmailInbox("session"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let available: boolean = false;
    await act(async () => {
      available = await result.current.checkUsername("my-agent");
    });
    expect(available).toBe(true);
    expect(mockGatewayFetch).toHaveBeenCalledWith(
      "/v1/email/inbox/check/my-agent",
      "session",
    );
  });

  it("checkUsername returns false when taken", async () => {
    mockGatewayFetch
      .mockResolvedValueOnce(MOCK_INBOX)
      .mockResolvedValueOnce({ available: false });

    const { result } = renderHook(() => useEmailInbox("session"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let available: boolean = true;
    await act(async () => {
      available = await result.current.checkUsername("taken-name");
    });
    expect(available).toBe(false);
  });

  it("checkUsername returns false when no apiKey", async () => {
    const { result } = renderHook(() => useEmailInbox(null));

    let available: boolean = true;
    await act(async () => {
      available = await result.current.checkUsername("test");
    });
    expect(available).toBe(false);
  });

  it("createInbox calls POST and refreshes", async () => {
    mockGatewayFetch
      .mockResolvedValueOnce(null) // initial fetch returns nothing (no inbox)
      .mockResolvedValueOnce({}) // createInbox POST
      .mockResolvedValueOnce(MOCK_INBOX); // refresh after create

    const { result } = renderHook(() => useEmailInbox("session"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.createInbox("test-agent", "Test Agent");
    });

    expect(mockGatewayFetch).toHaveBeenCalledWith("/v1/email/inbox", "session", {
      method: "POST",
      body: JSON.stringify({ username: "test-agent", displayName: "Test Agent" }),
    });
  });

  it("updateInbox calls PATCH and refreshes", async () => {
    mockGatewayFetch
      .mockResolvedValueOnce(MOCK_INBOX) // initial
      .mockResolvedValueOnce({}) // PATCH
      .mockResolvedValueOnce({ ...MOCK_INBOX, autoReply: "I'm away" }); // refresh

    const { result } = renderHook(() => useEmailInbox("session"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.updateInbox({ autoReply: "I'm away" });
    });

    expect(mockGatewayFetch).toHaveBeenCalledWith("/v1/email/inbox", "session", {
      method: "PATCH",
      body: JSON.stringify({ autoReply: "I'm away" }),
    });
  });

  it("deleteInbox calls DELETE and clears inbox", async () => {
    mockGatewayFetch
      .mockResolvedValueOnce(MOCK_INBOX) // initial
      .mockResolvedValueOnce({}); // DELETE

    const { result } = renderHook(() => useEmailInbox("session"));
    await waitFor(() => expect(result.current.inbox).toEqual(MOCK_INBOX));

    await act(async () => {
      await result.current.deleteInbox();
    });

    expect(mockGatewayFetch).toHaveBeenCalledWith("/v1/email/inbox", "session", { method: "DELETE" });
    expect(result.current.inbox).toBeNull();
  });
});

// ============================================================
//  useEmailMessages
// ============================================================

describe("useEmailMessages", () => {
  it("returns empty messages when no apiKey", () => {
    const { result } = renderHook(() => useEmailMessages(null));
    expect(result.current.messages).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it("fetches messages on mount", async () => {
    mockGatewayFetch.mockResolvedValueOnce({ messages: [MOCK_MESSAGE], total: 1 });
    const { result } = renderHook(() => useEmailMessages("session"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.messages).toEqual([MOCK_MESSAGE]);
    expect(result.current.total).toBe(1);
    expect(mockGatewayFetch).toHaveBeenCalledWith("/v1/email/messages", "session");
  });

  it("passes direction filter as query param", async () => {
    mockGatewayFetch.mockResolvedValueOnce({ messages: [], total: 0 });
    renderHook(() => useEmailMessages("session", { direction: "inbound" }));

    await waitFor(() => {
      expect(mockGatewayFetch).toHaveBeenCalledWith(
        "/v1/email/messages?direction=inbound",
        "session",
      );
    });
  });

  it("passes multiple filters as query params", async () => {
    mockGatewayFetch.mockResolvedValueOnce({ messages: [], total: 0 });
    renderHook(() => useEmailMessages("session", { direction: "outbound", limit: 20, offset: 10 }));

    await waitFor(() => {
      expect(mockGatewayFetch).toHaveBeenCalledWith(
        expect.stringContaining("direction=outbound"),
        "session",
      );
      expect(mockGatewayFetch).toHaveBeenCalledWith(
        expect.stringContaining("limit=20"),
        "session",
      );
      expect(mockGatewayFetch).toHaveBeenCalledWith(
        expect.stringContaining("offset=10"),
        "session",
      );
    });
  });

  it("markRead calls POST and refreshes", async () => {
    mockGatewayFetch
      .mockResolvedValueOnce({ messages: [MOCK_MESSAGE], total: 1 }) // initial
      .mockResolvedValueOnce({}) // markRead
      .mockResolvedValueOnce({ messages: [{ ...MOCK_MESSAGE, status: "read" }], total: 1 }); // refresh

    const { result } = renderHook(() => useEmailMessages("session"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.markRead("msg-1");
    });

    expect(mockGatewayFetch).toHaveBeenCalledWith("/v1/email/messages/msg-1/read", "session", {
      method: "POST",
    });
  });

  it("deleteMessage calls DELETE and refreshes", async () => {
    mockGatewayFetch
      .mockResolvedValueOnce({ messages: [MOCK_MESSAGE], total: 1 }) // initial
      .mockResolvedValueOnce({}) // DELETE
      .mockResolvedValueOnce({ messages: [], total: 0 }); // refresh

    const { result } = renderHook(() => useEmailMessages("session"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.deleteMessage("msg-1");
    });

    expect(mockGatewayFetch).toHaveBeenCalledWith("/v1/email/messages/msg-1", "session", {
      method: "DELETE",
    });
  });

  it("sendEmail calls POST with body and refreshes", async () => {
    mockGatewayFetch
      .mockResolvedValueOnce({ messages: [], total: 0 }) // initial
      .mockResolvedValueOnce({}) // sendEmail
      .mockResolvedValueOnce({ messages: [], total: 0 }); // refresh

    const { result } = renderHook(() => useEmailMessages("session"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.sendEmail("to@example.com", "Hello", "Body text", "<p>Body html</p>");
    });

    expect(mockGatewayFetch).toHaveBeenCalledWith("/v1/email/send", "session", {
      method: "POST",
      body: JSON.stringify({
        to: "to@example.com",
        subject: "Hello",
        bodyText: "Body text",
        bodyHtml: "<p>Body html</p>",
      }),
    });
  });

  it("replyToEmail calls POST with body and refreshes", async () => {
    mockGatewayFetch
      .mockResolvedValueOnce({ messages: [MOCK_MESSAGE], total: 1 }) // initial
      .mockResolvedValueOnce({}) // reply
      .mockResolvedValueOnce({ messages: [], total: 0 }); // refresh

    const { result } = renderHook(() => useEmailMessages("session"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.replyToEmail("msg-1", "Reply text");
    });

    expect(mockGatewayFetch).toHaveBeenCalledWith("/v1/email/msg-1/reply", "session", {
      method: "POST",
      body: JSON.stringify({ bodyText: "Reply text" }),
    });
  });
});

// ============================================================
//  useEmailStats
// ============================================================

describe("useEmailStats", () => {
  it("returns null stats when no apiKey", () => {
    const { result } = renderHook(() => useEmailStats(null));
    expect(result.current.stats).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("fetches stats on mount", async () => {
    mockGatewayFetch.mockResolvedValueOnce(MOCK_STATS);
    const { result } = renderHook(() => useEmailStats("session"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.stats).toEqual(MOCK_STATS);
    expect(mockGatewayFetch).toHaveBeenCalledWith("/v1/email/stats", "session");
  });

  it("silently handles fetch failure", async () => {
    mockGatewayFetch.mockRejectedValueOnce(new Error("500: server error"));
    const { result } = renderHook(() => useEmailStats("session"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.stats).toBeNull();
  });
});
