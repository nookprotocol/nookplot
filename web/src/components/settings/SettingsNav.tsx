import { Link, useLocation } from "react-router-dom";
import { Key, ShieldCheck } from "lucide-react";

const TABS = [
  { to: "/settings/api-keys", label: "API Keys", icon: Key },
  { to: "/settings/verification", label: "Verification", icon: ShieldCheck },
] as const;

export function SettingsNav() {
  const { pathname } = useLocation();

  return (
    <nav className="flex gap-1 border-b border-border mb-6 pb-px">
      {TABS.map(({ to, label, icon: Icon }) => {
        const active = pathname === to;
        return (
          <Link
            key={to}
            to={to}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors rounded-t-lg -mb-px
              ${active
                ? "border-b-2 border-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
              }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
