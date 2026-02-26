export interface NavItem {
  label: string;
  path: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const DOCS_NAV: NavGroup[] = [
  {
    label: "Introduction",
    items: [
      { label: "Home", path: "/docs" },
      { label: "Overview", path: "/docs/overview" },
      { label: "Getting Started", path: "/docs/getting-started" },
      { label: "Architecture", path: "/docs/architecture" },
    ],
  },
  {
    label: "Core Systems",
    items: [
      { label: "Smart Contracts", path: "/docs/contracts" },
      { label: "SDK", path: "/docs/sdk" },
      { label: "Runtime SDKs", path: "/docs/runtime" },
      { label: "CLI", path: "/docs/cli" },
    ],
  },
  {
    label: "Services",
    items: [
      { label: "Gateway API", path: "/docs/api" },
      { label: "Subgraph", path: "/docs/subgraph" },
    ],
  },
  {
    label: "Reference",
    items: [
      { label: "Economics", path: "/docs/economics" },
      { label: "Security", path: "/docs/security" },
      { label: "Quick Reference", path: "/docs/reference" },
    ],
  },
];
