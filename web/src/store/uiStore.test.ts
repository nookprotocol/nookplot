import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore } from "./uiStore";

describe("uiStore", () => {
  beforeEach(() => {
    useUIStore.setState({
      sidebarOpen: false,
      collapsedGroups: {},
      theme: "dark",
    });
    localStorage.clear();
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.className = "dark";
  });

  describe("sidebar", () => {
    it("starts with sidebar closed", () => {
      expect(useUIStore.getState().sidebarOpen).toBe(false);
    });

    it("toggleSidebar opens the sidebar", () => {
      useUIStore.getState().toggleSidebar();
      expect(useUIStore.getState().sidebarOpen).toBe(true);
    });

    it("toggleSidebar closes when open", () => {
      useUIStore.getState().toggleSidebar();
      useUIStore.getState().toggleSidebar();
      expect(useUIStore.getState().sidebarOpen).toBe(false);
    });

    it("setSidebarOpen sets exact state", () => {
      useUIStore.getState().setSidebarOpen(true);
      expect(useUIStore.getState().sidebarOpen).toBe(true);
      useUIStore.getState().setSidebarOpen(false);
      expect(useUIStore.getState().sidebarOpen).toBe(false);
    });
  });

  describe("collapsedGroups", () => {
    it("starts with no groups collapsed", () => {
      expect(useUIStore.getState().collapsedGroups).toEqual({});
    });

    it("toggleGroup collapses a group", () => {
      useUIStore.getState().toggleGroup("Marketplace");
      expect(useUIStore.getState().collapsedGroups["Marketplace"]).toBe(true);
    });

    it("toggleGroup expands a collapsed group", () => {
      useUIStore.getState().toggleGroup("Marketplace");
      useUIStore.getState().toggleGroup("Marketplace");
      expect(useUIStore.getState().collapsedGroups["Marketplace"]).toBe(false);
    });

    it("toggleGroup is independent per group", () => {
      useUIStore.getState().toggleGroup("Core");
      useUIStore.getState().toggleGroup("Agents");
      expect(useUIStore.getState().collapsedGroups["Core"]).toBe(true);
      expect(useUIStore.getState().collapsedGroups["Agents"]).toBe(true);
      expect(useUIStore.getState().collapsedGroups["Marketplace"]).toBeUndefined();
    });
  });

  describe("theme", () => {
    it("starts with dark theme", () => {
      expect(useUIStore.getState().theme).toBe("dark");
    });

    it("toggleTheme switches from dark to light", () => {
      useUIStore.getState().toggleTheme();
      expect(useUIStore.getState().theme).toBe("light");
    });

    it("toggleTheme switches from light back to dark", () => {
      useUIStore.getState().toggleTheme();
      useUIStore.getState().toggleTheme();
      expect(useUIStore.getState().theme).toBe("dark");
    });

    it("toggleTheme updates data-theme attribute on html element", () => {
      useUIStore.getState().toggleTheme();
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");

      useUIStore.getState().toggleTheme();
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });

    it("toggleTheme persists to localStorage", () => {
      useUIStore.getState().toggleTheme();
      expect(localStorage.getItem("nookplot-theme")).toBe("light");

      useUIStore.getState().toggleTheme();
      expect(localStorage.getItem("nookplot-theme")).toBe("dark");
    });

    it("toggleTheme updates html class for class-based selectors", () => {
      useUIStore.getState().toggleTheme();
      expect(document.documentElement.classList.contains("light")).toBe(true);
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });
  });
});
