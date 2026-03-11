import { describe, it, expect, beforeEach, vi } from "vitest";

// jsdom's localStorage doesn't support .length or key() properly.
// Test the clearPrivyKeys logic directly with a mock Storage.
function createMockStorage(items: Record<string, string>): Storage {
  const store = new Map(Object.entries(items));
  return {
    get length() { return store.size; },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    getItem(key: string) { return store.get(key) ?? null; },
    setItem(key: string, value: string) { store.set(key, value); },
    removeItem(key: string) { store.delete(key); },
    clear() { store.clear(); },
  };
}

describe("privyLogout", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("clears privy-prefixed keys from localStorage", async () => {
    const mockLS = createMockStorage({
      "privy:token": "abc",
      "privy-session": "def",
      "nookplot_session": "keep-this",
    });

    // Replace globalThis.localStorage for this test
    vi.stubGlobal("localStorage", mockLS);
    vi.stubGlobal("sessionStorage", createMockStorage({}));

    const { default: privyLogout } = await import("../privyLogout");
    await privyLogout();

    expect(mockLS.getItem("privy:token")).toBeNull();
    expect(mockLS.getItem("privy-session")).toBeNull();
    expect(mockLS.getItem("nookplot_session")).toBe("keep-this");
  });

  it("clears privy-prefixed keys from sessionStorage", async () => {
    const mockSS = createMockStorage({
      "privy:state": "ghi",
      "privy-cache": "jkl",
      "other-key": "keep",
    });

    vi.stubGlobal("localStorage", createMockStorage({}));
    vi.stubGlobal("sessionStorage", mockSS);

    const { default: privyLogout } = await import("../privyLogout");
    await privyLogout();

    expect(mockSS.getItem("privy:state")).toBeNull();
    expect(mockSS.getItem("privy-cache")).toBeNull();
    expect(mockSS.getItem("other-key")).toBe("keep");
  });

  it("does nothing when no privy keys exist", async () => {
    const mockLS = createMockStorage({
      "nookplot_session": "session",
      "some_other_key": "val",
    });

    vi.stubGlobal("localStorage", mockLS);
    vi.stubGlobal("sessionStorage", createMockStorage({}));

    const { default: privyLogout } = await import("../privyLogout");
    await privyLogout();

    expect(mockLS.getItem("nookplot_session")).toBe("session");
    expect(mockLS.getItem("some_other_key")).toBe("val");
    expect(mockLS.length).toBe(2);
  });
});
