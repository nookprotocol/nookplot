import { CheckCircle, Circle, AlertTriangle, XCircle } from "lucide-react";

interface Props {
  status: string;
  createdAt: string;
  deadline: string | null;
  settledAt: string | null;
}

const STEPS = [
  { key: "agreed", label: "Agreed", statusNum: 1 },
  { key: "delivered", label: "Delivered", statusNum: 2 },
  { key: "settled", label: "Settled", statusNum: 3 },
];

const STATUS_NUM: Record<string, number> = {
  agreed: 1,
  delivered: 2,
  settled: 3,
  disputed: 4,
  cancelled: 5,
};

function formatDate(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function StatusTimeline({ status, createdAt, settledAt }: Props) {
  const currentNum = STATUS_NUM[status] ?? 0;
  const isDiverged = currentNum === 4 || currentNum === 5;

  return (
    <div className="space-y-3">
      {/* Main timeline */}
      <div className="flex items-center gap-2">
        {STEPS.map((step, i) => {
          const isCompleted = !isDiverged && currentNum >= step.statusNum;
          const isCurrent = !isDiverged && currentNum === step.statusNum;

          return (
            <div key={step.key} className="flex items-center gap-2 flex-1">
              <div className="flex flex-col items-center gap-1">
                <div className={`flex items-center justify-center w-8 h-8 rounded-full border-2 ${
                  isCompleted
                    ? "border-emerald-500 bg-emerald-500/15"
                    : isCurrent
                      ? "border-accent bg-accent/15"
                      : "border-border bg-card"
                }`}>
                  {isCompleted && currentNum > step.statusNum ? (
                    <CheckCircle className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <Circle className={`w-4 h-4 ${
                      isCompleted ? "text-emerald-400" : isCurrent ? "text-accent" : "text-muted-foreground"
                    }`} />
                  )}
                </div>
                <span className={`text-xs ${
                  isCompleted || isCurrent ? "text-foreground font-medium" : "text-muted-foreground"
                }`}>
                  {step.label}
                </span>
                {step.statusNum === 1 && (
                  <span className="text-[10px] text-muted-foreground">{formatDate(createdAt)}</span>
                )}
                {step.statusNum === 3 && settledAt && (
                  <span className="text-[10px] text-muted-foreground">{formatDate(settledAt)}</span>
                )}
              </div>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 h-0.5 ${
                  !isDiverged && currentNum > step.statusNum ? "bg-emerald-500/50" : "bg-border"
                }`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Diverged state indicator */}
      {isDiverged && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
          currentNum === 4
            ? "border-red-500/30 bg-red-500/10"
            : "border-gray-500/30 bg-gray-500/10"
        }`}>
          {currentNum === 4 ? (
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          ) : (
            <XCircle className="w-4 h-4 text-gray-400 shrink-0" />
          )}
          <span className={`text-sm font-medium ${
            currentNum === 4 ? "text-red-400" : "text-gray-400"
          }`}>
            {currentNum === 4 ? "Agreement Disputed" : "Agreement Cancelled"}
          </span>
        </div>
      )}
    </div>
  );
}
