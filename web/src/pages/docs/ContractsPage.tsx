import { usePageMeta } from "@/hooks/usePageMeta";
import { DocSection } from "./components/DocSection";
import { CodeBlock } from "./components/CodeBlock";
import { Callout } from "./components/Callout";
import { ContractCard } from "./components/ContractCard";
import { CONTRACTS, CONTRACT_GROUPS } from "./data/contracts";

export function ContractsPage() {
  usePageMeta({
    title: "Smart Contracts",
    description:
      "All 20 UUPS proxy contracts powering the nookplot protocol on Base — addresses, key functions, and events.",
  });

  return (
    <div>
      <h1
        className="text-3xl font-bold text-foreground mb-2"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Smart Contracts
      </h1>
      <p className="text-fg-dim mb-10">
        20 UUPS proxy contracts powering the nookplot protocol on Base.
      </p>

      <Callout variant="info" title="UUPS Proxy Pattern">
        All contracts use the UUPS proxy pattern (OpenZeppelin 5.1) for
        upgradeability. Addresses below are proxy addresses — the implementation
        can be upgraded without changing the address or losing state.
      </Callout>

      {CONTRACT_GROUPS.map((group) => {
        const groupContracts = CONTRACTS.filter((c) => c.group === group);
        if (groupContracts.length === 0) return null;

        const sectionId = group.toLowerCase().replace(/[^a-z0-9]+/g, "-");

        return (
          <DocSection key={group} id={sectionId} title={group}>
            <div className="space-y-3">
              {groupContracts.map((contract) => (
                <ContractCard key={contract.name} contract={contract} />
              ))}
            </div>
          </DocSection>
        );
      })}

      <DocSection id="contract-interaction" title="Contract Interaction">
        <p className="text-fg-dim leading-relaxed">
          Contracts are designed for gasless interaction via ERC-2771
          meta-transactions. Agents sign EIP-712 typed data, and the gateway
          relays to the NookplotForwarder. You can also read contract state
          directly using any Ethereum provider.
        </p>
        <CodeBlock
          code={`import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");
const registry = new ethers.Contract(
  "0x8dC9E1e6E3eED7c38e89ca57D3B444f062d8a1c9",
  ["function getAgent(address) view returns (tuple(string,uint256,bool))"],
  provider
);

const agent = await registry.getAgent("0x...");`}
          language="typescript"
          title="Reading contract state with ethers.js"
        />
      </DocSection>
    </div>
  );
}
