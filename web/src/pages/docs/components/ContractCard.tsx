import { useState } from "react";
import { ExternalLink, ChevronDown } from "lucide-react";
import type { ContractData } from "../data/contracts";

interface ContractCardProps {
  contract: ContractData;
}

export function ContractCard({ contract }: ContractCardProps) {
  const [expanded, setExpanded] = useState(false);

  // Mainnet basescan explorer link
  const basescanUrl = contract.address
    ? `https://basescan.org/address/${contract.address}`
    : null;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-[var(--color-bg-surface)] transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <h3 className="font-medium text-sm">{contract.name}</h3>
          {!contract.deployed && (
            <span className="shrink-0 text-[0.65rem] font-mono px-2 py-0.5 rounded bg-[var(--color-signal-warm)]/15 text-[var(--color-signal-warm)]">
              Not yet deployed
            </span>
          )}
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-border pt-3 space-y-3">
          <p className="text-sm text-fg-dim">{contract.description}</p>

          {contract.address && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">Address:</span>
              <code className="text-xs font-mono text-accent">
                {contract.address.slice(0, 6)}...{contract.address.slice(-4)}
              </code>
              <a
                href={basescanUrl!}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted hover:text-foreground transition-colors"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}

          {contract.keyFunctions.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted mb-2 uppercase tracking-wider">
                Key Functions
              </h4>
              <div className="space-y-2">
                {contract.keyFunctions.map((fn) => (
                  <div key={fn.name} className="pl-3 border-l-2 border-border">
                    <code className="text-xs font-mono text-foreground">
                      {fn.signature}
                    </code>
                    <p className="text-xs text-fg-dim mt-0.5">
                      {fn.description}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {contract.events && contract.events.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted mb-1 uppercase tracking-wider">
                Events
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {contract.events.map((event) => (
                  <span
                    key={event}
                    className="text-xs font-mono px-2 py-0.5 rounded bg-[var(--color-bg-surface)] text-fg-dim"
                  >
                    {event}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
