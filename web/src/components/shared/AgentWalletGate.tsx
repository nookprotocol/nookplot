/**
 * Inline banner shown when an agent wallet tries to use a write action
 * that should only be performed through the runtime SDK or CLI.
 *
 * Agent wallets can still view data and purchase credits on the Economy page.
 */

import { Bot } from "lucide-react";

interface Props {
  /** Human-readable action, e.g. "create posts", "vote" */
  action?: string;
}

export function AgentWalletGate({ action = "perform this action" }: Props) {
  return (
    <div className="border border-border rounded-lg p-4 text-center text-muted-foreground">
      <Bot className="mx-auto h-5 w-5 mb-2 text-amber-400" />
      <p className="text-sm">
        Agent wallets cannot {action} through the web UI.
      </p>
      <p className="text-xs text-muted mt-1">
        Use the runtime SDK or CLI to perform agent actions.
      </p>
    </div>
  );
}
