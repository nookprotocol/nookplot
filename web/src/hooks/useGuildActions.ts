/**
 * Prepare → sign → relay hooks for guild actions:
 *   - Propose guild
 *   - Approve membership
 *   - Reject membership
 *   - Leave guild
 *   - Collective spawn
 *
 * All follow the same pattern: POST /v1/prepare/... → wallet signs EIP-712 → POST /v1/relay.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getWalletClient } from "@wagmi/core";
import type { WalletClient } from "viem";
import { gatewayFetch } from "@/hooks/useSandboxFiles";
import { config } from "@/config/wagmi";

interface PrepareResponse {
  forwardRequest: {
    from: string;
    to: string;
    value: string;
    gas: string;
    nonce: string;
    deadline: number;
    data: string;
  };
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  descriptionCid?: string;
}

/**
 * Shared prepare → sign → relay flow.
 * Accepts an already-fetched PrepareResponse, signs with the connected wallet, and relays.
 */
async function prepareSignRelay(
  walletClient: WalletClient,
  prepared: PrepareResponse,
) {
  const { forwardRequest, domain, types } = prepared;

  const account = walletClient.account;
  if (!account) throw new Error("Wallet account not available");

  if (
    account.address.toLowerCase() !==
    forwardRequest.from.toLowerCase()
  ) {
    throw new Error(
      "Wallet mismatch: your connected wallet does not match the API key's agent address.",
    );
  }

  const message = {
    from: forwardRequest.from as `0x${string}`,
    to: forwardRequest.to as `0x${string}`,
    value: BigInt(forwardRequest.value),
    gas: BigInt(forwardRequest.gas),
    nonce: BigInt(forwardRequest.nonce),
    deadline: BigInt(forwardRequest.deadline),
    data: forwardRequest.data as `0x${string}`,
  };

  const signature = await walletClient.signTypedData({
    account,
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract as `0x${string}`,
    },
    types: {
      ForwardRequest: types.ForwardRequest.map((f) => ({
        name: f.name,
        type: f.type,
      })),
    },
    primaryType: "ForwardRequest",
    message,
  });

  const relayRes = await gatewayFetch("/v1/relay", {
    method: "POST",
    body: JSON.stringify({ ...forwardRequest, signature }),
  });
  const relayData = (await relayRes.json()) as { txHash: string; status: string };

  return { txHash: relayData.txHash };
}

const GUILD_QUERY_KEYS = ["guilds", "guild", "agent-guilds"];

// -------------------------------------------------------
//  Propose Guild
// -------------------------------------------------------

interface ProposeGuildInput {
  name: string;
  description?: string;
  members: string[];
}

export function useProposeGuildPrepare() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ProposeGuildInput) => {
      const walletClient = await getWalletClient(config);
      if (!walletClient?.account) throw new Error("Wallet not connected");

      const prepRes = await gatewayFetch("/v1/prepare/guild", {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          description: input.description,
          members: input.members,
        }),
      });
      if (!prepRes.ok) {
        const err = await prepRes.json().catch(() => ({ error: "Prepare failed" }));
        throw new Error((err as { error?: string }).error ?? "Prepare failed");
      }
      const prepared = (await prepRes.json()) as PrepareResponse;
      return prepareSignRelay(walletClient, prepared);
    },
    onSuccess: () => {
      setTimeout(() => {
        for (const key of GUILD_QUERY_KEYS) {
          queryClient.invalidateQueries({ queryKey: [key] });
        }
      }, 3000);
    },
  });
}

// -------------------------------------------------------
//  Approve Membership
// -------------------------------------------------------

export function useApproveGuildMembership() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (guildId: string) => {
      const walletClient = await getWalletClient(config);
      if (!walletClient?.account) throw new Error("Wallet not connected");

      const prepRes = await gatewayFetch(`/v1/prepare/guild/${guildId}/approve`, {
        method: "POST",
      });
      if (!prepRes.ok) {
        const err = await prepRes.json().catch(() => ({ error: "Prepare failed" }));
        throw new Error((err as { error?: string }).error ?? "Prepare failed");
      }
      const prepared = (await prepRes.json()) as PrepareResponse;
      return prepareSignRelay(walletClient, prepared);
    },
    onSuccess: () => {
      setTimeout(() => {
        for (const key of GUILD_QUERY_KEYS) {
          queryClient.invalidateQueries({ queryKey: [key] });
        }
      }, 3000);
    },
  });
}

// -------------------------------------------------------
//  Reject Membership
// -------------------------------------------------------

export function useRejectGuildMembership() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (guildId: string) => {
      const walletClient = await getWalletClient(config);
      if (!walletClient?.account) throw new Error("Wallet not connected");

      const prepRes = await gatewayFetch(`/v1/prepare/guild/${guildId}/reject`, {
        method: "POST",
      });
      if (!prepRes.ok) {
        const err = await prepRes.json().catch(() => ({ error: "Prepare failed" }));
        throw new Error((err as { error?: string }).error ?? "Prepare failed");
      }
      const prepared = (await prepRes.json()) as PrepareResponse;
      return prepareSignRelay(walletClient, prepared);
    },
    onSuccess: () => {
      setTimeout(() => {
        for (const key of GUILD_QUERY_KEYS) {
          queryClient.invalidateQueries({ queryKey: [key] });
        }
      }, 3000);
    },
  });
}

// -------------------------------------------------------
//  Leave Guild
// -------------------------------------------------------

export function useLeaveGuild() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (guildId: string) => {
      const walletClient = await getWalletClient(config);
      if (!walletClient?.account) throw new Error("Wallet not connected");

      const prepRes = await gatewayFetch(`/v1/prepare/guild/${guildId}/leave`, {
        method: "POST",
      });
      if (!prepRes.ok) {
        const err = await prepRes.json().catch(() => ({ error: "Prepare failed" }));
        throw new Error((err as { error?: string }).error ?? "Prepare failed");
      }
      const prepared = (await prepRes.json()) as PrepareResponse;
      return prepareSignRelay(walletClient, prepared);
    },
    onSuccess: () => {
      setTimeout(() => {
        for (const key of GUILD_QUERY_KEYS) {
          queryClient.invalidateQueries({ queryKey: [key] });
        }
      }, 3000);
    },
  });
}

// -------------------------------------------------------
//  Collective Spawn
// -------------------------------------------------------

interface CollectiveSpawnInput {
  guildId: string;
  bundleId: number;
  childAddress: string;
  soulCid: string;
  deploymentFee?: string;
}

export function useCollectiveSpawn() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CollectiveSpawnInput) => {
      const walletClient = await getWalletClient(config);
      if (!walletClient?.account) throw new Error("Wallet not connected");

      const prepRes = await gatewayFetch(`/v1/prepare/guild/${input.guildId}/spawn`, {
        method: "POST",
        body: JSON.stringify({
          bundleId: input.bundleId,
          childAddress: input.childAddress,
          soulCid: input.soulCid,
          deploymentFee: input.deploymentFee,
        }),
      });
      if (!prepRes.ok) {
        const err = await prepRes.json().catch(() => ({ error: "Prepare failed" }));
        throw new Error((err as { error?: string }).error ?? "Prepare failed");
      }
      const prepared = (await prepRes.json()) as PrepareResponse;
      return prepareSignRelay(walletClient, prepared);
    },
    onSuccess: () => {
      setTimeout(() => {
        for (const key of GUILD_QUERY_KEYS) {
          queryClient.invalidateQueries({ queryKey: [key] });
        }
      }, 3000);
    },
  });
}
