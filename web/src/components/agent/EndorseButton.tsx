import { useState } from "react";
import { useAccount } from "wagmi";
import { useEndorse } from "@/hooks/useEndorse";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { Star, Plus } from "lucide-react";

interface Props {
  subject: `0x${string}`;
}

export function EndorseButton({ subject }: Props) {
  const { address } = useAccount();
  const { isAgent } = useIsAgentWallet();
  const { endorse, isPending, isSuccess } = useEndorse();
  const [showForm, setShowForm] = useState(false);
  const [skill, setSkill] = useState("");
  const [rating, setRating] = useState(0);
  const [context, setContext] = useState("");

  if (!address || address.toLowerCase() === subject.toLowerCase() || isAgent) return null;

  if (isSuccess) {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-success">
        <Star className="h-3.5 w-3.5" />
        Endorsed
      </span>
    );
  }

  if (showForm) {
    return (
      <div className="flex gap-2 items-center flex-wrap">
        <input
          type="text"
          placeholder="Skill (e.g. research)"
          value={skill}
          onChange={(e) => setSkill(e.target.value.toLowerCase().slice(0, 64))}
          className="bg-transparent border border-border rounded px-2 py-1 text-sm focus:outline-none focus:border-accent w-36"
        />
        <div className="flex gap-0.5 text-lg">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setRating(n)}
              className={`cursor-pointer select-none ${n <= rating ? "text-[var(--color-signal-warm)]" : "text-[var(--color-stone)]"}`}
            >
              ★
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Context (optional)"
          value={context}
          onChange={(e) => setContext(e.target.value.slice(0, 256))}
          className="bg-transparent border border-border rounded px-2 py-1 text-sm focus:outline-none focus:border-accent w-44"
        />
        <button
          onClick={() => {
            if (skill.trim().length >= 2 && rating > 0) {
              endorse(subject, skill.trim(), rating, context.trim() || undefined);
            }
          }}
          disabled={skill.trim().length < 2 || rating === 0 || isPending}
          className="px-3 py-1 bg-accent text-white rounded text-sm disabled:opacity-50"
        >
          {isPending ? "..." : "Submit"}
        </button>
        <button
          onClick={() => { setShowForm(false); setSkill(""); setRating(0); setContext(""); }}
          className="text-sm text-muted hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setShowForm(true)}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
      style={{
        background: "var(--color-accent-soft)",
        color: "var(--color-accent)",
        border: "1px solid rgba(109, 184, 116, 0.2)",
      }}
    >
      <Plus className="h-3.5 w-3.5" />
      Endorse
    </button>
  );
}
