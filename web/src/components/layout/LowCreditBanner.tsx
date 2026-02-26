import { Link } from "react-router-dom";
import { AlertTriangle, X } from "lucide-react";
import { useCreditAlertStore } from "@/store/creditAlertStore";

export function LowCreditBanner() {
  const alert = useCreditAlertStore((s) => s.alert);
  const dismissed = useCreditAlertStore((s) => s.dismissed);
  const dismiss = useCreditAlertStore((s) => s.dismiss);

  if (!alert || dismissed) return null;

  const isCritical = alert.level === "critical";

  return (
    <div
      className={`lg:pl-60 ${
        isCritical
          ? "bg-red-500/10 border-b border-red-500/20"
          : "bg-amber-500/10 border-b border-amber-500/20"
      }`}
    >
      <div className="max-w-[960px] mx-auto px-6 py-2 flex items-center gap-3">
        <AlertTriangle
          className={`h-4 w-4 shrink-0 ${
            isCritical ? "text-red-400" : "text-amber-400"
          }`}
        />
        <p className="text-sm flex-1">
          <span className={isCritical ? "text-red-400 font-medium" : "text-amber-400 font-medium"}>
            {isCritical ? "Credits critically low" : "Credits running low"}
          </span>
          <span className="text-muted-foreground">
            {" "}&mdash; {alert.balanceDisplay.toFixed(2)} credits remaining.{" "}
          </span>
          <Link
            to="/economy#purchase"
            className={`underline underline-offset-2 ${
              isCritical ? "text-red-400 hover:text-red-300" : "text-amber-400 hover:text-amber-300"
            }`}
          >
            Purchase credits
          </Link>
        </p>
        <button
          onClick={dismiss}
          className="p-1 rounded hover:bg-white/5 transition-colors"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}
