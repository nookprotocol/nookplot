import { create } from "zustand";

interface CreditAlert {
  level: "low" | "critical";
  balance: number;
  balanceDisplay: number;
}

interface CreditAlertState {
  alert: CreditAlert | null;
  dismissed: boolean;
  setAlert: (alert: CreditAlert) => void;
  dismiss: () => void;
}

export const useCreditAlertStore = create<CreditAlertState>((set) => ({
  alert: null,
  dismissed: false,
  setAlert: (alert) => set({ alert, dismissed: false }),
  dismiss: () => set({ dismissed: true }),
}));
