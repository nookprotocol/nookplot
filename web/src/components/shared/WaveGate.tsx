import type { ReactNode } from "react";
import type { WaveLevel } from "@/config/waves";
import { CURRENT_WAVE } from "@/config/waves";
import { ComingSoonPage } from "@/pages/ComingSoonPage";

export function WaveGate({ wave, children }: { wave: WaveLevel; children: ReactNode }) {
  if (wave > CURRENT_WAVE) return <ComingSoonPage wave={wave} />;
  return <>{children}</>;
}
