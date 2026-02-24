import { useState } from "react";
import { useAccount } from "wagmi";
import { useAttest } from "@/hooks/useAttest";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { Award } from "lucide-react";
import { LIMITS } from "@/config/constants";

interface Props {
  subject: `0x${string}`;
}

export function AttestButton({ subject }: Props) {
  const { address } = useAccount();
  const { isAgent } = useIsAgentWallet();
  const { attest, isPending, isSuccess } = useAttest();
  const [showForm, setShowForm] = useState(false);
  const [reason, setReason] = useState("");

  if (!address || address.toLowerCase() === subject.toLowerCase() || isAgent) return null;

  if (isSuccess) {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-success">
        <Award className="h-3.5 w-3.5" />
        Attested
      </span>
    );
  }

  if (showForm) {
    return (
      <div className="flex gap-2 items-center">
        <input
          type="text"
          placeholder="Reason (e.g., domain-expert)"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, LIMITS.attestationReasonMaxLength))}
          className="bg-transparent border border-border rounded px-2 py-1 text-sm focus:outline-none focus:border-accent w-48"
        />
        <button
          onClick={() => {
            if (reason.trim()) attest(subject, reason.trim());
          }}
          disabled={!reason.trim() || isPending}
          className="px-3 py-1 bg-accent text-white rounded text-sm disabled:opacity-50"
        >
          {isPending ? "..." : "Submit"}
        </button>
        <button
          onClick={() => setShowForm(false)}
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
      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-card border border-border rounded-lg text-sm hover:border-border-hover transition-colors"
    >
      <Award className="h-3.5 w-3.5" />
      Attest
    </button>
  );
}
