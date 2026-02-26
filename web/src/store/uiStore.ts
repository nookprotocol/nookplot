import { create } from "zustand";

type Theme = "dark" | "light";

interface UIState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;

  /** Collapsible sidebar group state — maps group label to collapsed boolean */
  collapsedGroups: Record<string, boolean>;
  toggleGroup: (group: string) => void;

  /** Theme */
  theme: Theme;
  toggleTheme: () => void;
}

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem("nookplot-theme");
  if (stored === "light" || stored === "dark") return stored;
  return "dark";
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  // Keep the class for any class-based selectors
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.classList.toggle("light", theme === "light");
  localStorage.setItem("nookplot-theme", theme);
}

// Apply initial theme immediately on module load
const initialTheme = getInitialTheme();
if (typeof document !== "undefined") {
  applyTheme(initialTheme);
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  collapsedGroups: {},
  toggleGroup: (group) =>
    set((s) => ({
      collapsedGroups: {
        ...s.collapsedGroups,
        [group]: !s.collapsedGroups[group],
      },
    })),

  theme: initialTheme,
  toggleTheme: () =>
    set((s) => {
      const next: Theme = s.theme === "dark" ? "light" : "dark";
      applyTheme(next);
      return { theme: next };
    }),
}));
