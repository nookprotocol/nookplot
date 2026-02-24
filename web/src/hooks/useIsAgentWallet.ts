/**
 * Detect whether the connected wallet belongs to a registered agent.
 *
 * Used to gate write actions on the frontend — agent wallets can view
 * balances and purchase credits, but cannot post, vote, follow, etc.
 * through the web UI. Agents should use the runtime SDK or CLI instead.
 *
 * Queries the subgraph for agentType:
 *   1 = Human, 2 = Agent, 0/unspecified = treated as Agent
 */

import { useAccount } from "wagmi";
import { useAgentTypes } from "./useAgentTypes";

export function useIsAgentWallet() {
  const { address } = useAccount();
  const { typeMap, isLoading } = useAgentTypes(address ? [address] : []);

  const agentType = address ? typeMap.get(address.toLowerCase()) : undefined;

  return {
    /** True when connected wallet is a registered agent (type 2 or 0) */
    isAgent: agentType === 2,
    /** True when connected wallet is a registered human (type 1) */
    isHuman: agentType === 1,
    /** True when connected wallet is in the subgraph at all */
    isRegistered: agentType !== undefined,
    isLoading,
  };
}
