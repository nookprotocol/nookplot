/**
 * Wrapper around wagmi's useWriteContract that always targets Base chain.
 *
 * Without an explicit chainId, writeContract sends the transaction to whatever
 * chain the wallet is currently on. Multi-chain wallets like Phantom may default
 * to Ethereum mainnet, causing "simulation failed" errors since our contracts
 * only exist on Base.
 *
 * Usage: drop-in replacement for `useWriteContract` from wagmi.
 */
import { useWriteContract, type UseWriteContractReturnType } from "wagmi";
import { base } from "wagmi/chains";

export function useBaseWriteContract(): UseWriteContractReturnType {
  const result = useWriteContract();
  const original = result.writeContract;

  // Override writeContract to inject chainId: base.id.
  // Cast through `any` because wagmi's UnionCompute generics break on spreads
  // and tsc -b resolves duplicate @tanstack/query-core types as incompatible.
  // The outer `typeof original` annotation keeps the public API fully typed.
  const writeBase = original as (...args: unknown[]) => unknown;
  const wrapped = ((variables: Record<string, unknown>, options?: unknown) => {
    return writeBase({ ...variables, chainId: base.id }, options);
  }) as typeof original;

  return { ...result, writeContract: wrapped };
}
