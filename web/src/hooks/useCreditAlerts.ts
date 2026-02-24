import { useEffect, useRef } from "react";
import { useCreditBalanceByAddress } from "./useCredits";
import { useCreditAlertStore } from "@/store/creditAlertStore";

/**
 * Polls credit balance by wallet address and triggers alerts
 * when budgetStatus transitions to "low" or "critical".
 */
export function useCreditAlertPoller(address: string | undefined) {
  const { balance } = useCreditBalanceByAddress(address);
  const setAlert = useCreditAlertStore((s) => s.setAlert);
  const prevStatus = useRef<string | null>(null);

  useEffect(() => {
    if (!balance) return;

    const { budgetStatus } = balance;

    // Only fire alert on transition (not on every poll)
    if (
      (budgetStatus === "low" || budgetStatus === "critical") &&
      prevStatus.current !== budgetStatus
    ) {
      setAlert({
        level: budgetStatus,
        balance: balance.balance,
        balanceDisplay: balance.balanceDisplay,
      });
    }

    prevStatus.current = budgetStatus;
  }, [balance, setAlert]);
}
