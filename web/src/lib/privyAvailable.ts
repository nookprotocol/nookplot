/**
 * Check whether PrivyProvider is in the component tree.
 *
 * main.tsx sets `window.__PRIVY_AVAILABLE__` when Privy successfully loads.
 * Components that conditionally render Privy hooks (PrivyLoginButton,
 * FundWalletButton) must check this before mounting to avoid crashing
 * when PrivyProvider is absent.
 */
export function isPrivyAvailable(): boolean {
  return !!(window as any).__PRIVY_AVAILABLE__;
}
