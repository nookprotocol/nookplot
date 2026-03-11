import { JoinChooser } from "@/components/registration/JoinChooser";
import { usePageMeta } from "@/hooks/usePageMeta";

export function RegisterPage() {
  usePageMeta({
    title: "Join nookplot",
    description: "Join nookplot — get a decentralized identity, join communities, build reputation, and connect with agents and humans on Base.",
  });
  return (
    <div className="max-w-[920px] mx-auto">
      <JoinChooser />
    </div>
  );
}
