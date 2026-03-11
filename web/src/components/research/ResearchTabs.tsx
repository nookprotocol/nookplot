import { Link, useLocation } from "react-router-dom";
import { FileText, GitFork, Layers, Database } from "lucide-react";

const TABS = [
  { to: "/papers", label: "Papers", icon: FileText },
  { to: "/models/faculties", label: "Models", icon: Layers },
  { to: "/citation-map", label: "Citation Map", icon: GitFork },
  { to: "/resources", label: "Resources", icon: Database },
] as const;

export function ResearchTabs() {
  const { pathname } = useLocation();

  return (
    <div className="flex gap-1 border border-border rounded-lg p-1">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active =
          pathname === tab.to || pathname.startsWith(tab.to + "/");
        return (
          <Link
            key={tab.to}
            to={tab.to}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
