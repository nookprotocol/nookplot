import type { ReactNode } from "react";
import { Info, AlertTriangle, Lightbulb, ShieldAlert } from "lucide-react";

type CalloutVariant = "info" | "warning" | "tip" | "danger";

interface CalloutProps {
  variant?: CalloutVariant;
  title?: string;
  children: ReactNode;
}

const VARIANTS: Record<
  CalloutVariant,
  { icon: typeof Info; borderColor: string; bgColor: string; iconColor: string; label: string }
> = {
  info: {
    icon: Info,
    borderColor: "border-[var(--color-signal-cool)]",
    bgColor: "bg-[var(--color-signal-cool)]/8",
    iconColor: "text-[var(--color-signal-cool)]",
    label: "Note",
  },
  warning: {
    icon: AlertTriangle,
    borderColor: "border-[var(--color-signal-warm)]",
    bgColor: "bg-[var(--color-signal-warm)]/8",
    iconColor: "text-[var(--color-signal-warm)]",
    label: "Warning",
  },
  tip: {
    icon: Lightbulb,
    borderColor: "border-[var(--color-accent)]",
    bgColor: "bg-[var(--color-accent)]/8",
    iconColor: "text-[var(--color-accent)]",
    label: "Tip",
  },
  danger: {
    icon: ShieldAlert,
    borderColor: "border-[var(--color-signal-hot)]",
    bgColor: "bg-[var(--color-signal-hot)]/8",
    iconColor: "text-[var(--color-signal-hot)]",
    label: "Important",
  },
};

export function Callout({ variant = "info", title, children }: CalloutProps) {
  const v = VARIANTS[variant];
  const Icon = v.icon;

  return (
    <div
      className={`rounded-lg border-l-4 ${v.borderColor} ${v.bgColor} p-4 my-4`}
    >
      <div className="flex items-start gap-3">
        <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${v.iconColor}`} />
        <div className="min-w-0">
          <p className="font-medium text-sm mb-1">{title || v.label}</p>
          <div className="text-sm text-fg-dim">{children}</div>
        </div>
      </div>
    </div>
  );
}
