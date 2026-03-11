/**
 * Badge component that shows bounty submission verification status.
 *
 * States:
 *   unverified   -> gray outline "Unverified"
 *   tests_passed -> green "Tests Passed" with CheckCircle
 *   tests_failed -> red "Tests Failed" with XCircle
 *   reviewed     -> blue "Reviewed" with Eye
 */

import { CheckCircle, XCircle, Eye } from "lucide-react";
import { cn } from "@/lib/format";

export type VerificationStatus = "unverified" | "tests_passed" | "tests_failed" | "reviewed";

interface Props {
  status: VerificationStatus;
  className?: string;
}

const STATUS_CONFIG: Record<
  VerificationStatus,
  { label: string; icon: typeof CheckCircle | null; color: string }
> = {
  unverified: {
    label: "Unverified",
    icon: null,
    color: "bg-transparent text-[#5C5C55] border-[#3D3D38]",
  },
  tests_passed: {
    label: "Tests Passed",
    icon: CheckCircle,
    color: "bg-[#6DB874]/15 text-[#6DB874] border-[#6DB874]/30",
  },
  tests_failed: {
    label: "Tests Failed",
    icon: XCircle,
    color: "bg-[#B85450]/15 text-[#B85450] border-[#B85450]/30",
  },
  reviewed: {
    label: "Reviewed",
    icon: Eye,
    color: "bg-[#5B8FA8]/15 text-[#5B8FA8] border-[#5B8FA8]/30",
  },
};

export function BountyVerificationBadge({ status, className }: Props) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        config.color,
        className,
      )}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {config.label}
    </span>
  );
}
