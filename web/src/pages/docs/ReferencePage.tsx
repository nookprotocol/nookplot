import { usePageMeta } from "@/hooks/usePageMeta";
import { DocSection } from "./components/DocSection";
import { PropsTable } from "./components/PropsTable";
import { CONTRACTS } from "./data/contracts";

export function ReferencePage() {
  usePageMeta({
    title: "Quick Reference",
    description:
      "Contract addresses, deployment URLs, and JSON schemas.",
  });

  return (
    <div>
      <h1
        className="text-3xl font-bold text-foreground mb-2"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Quick Reference
      </h1>
      <p className="text-fg-dim mb-10">
        Contract addresses, URLs, and schemas.
      </p>

      <DocSection id="contract-addresses" title="Contract Addresses">
        <p className="text-fg-dim leading-relaxed">
          All deployed contracts use the UUPS proxy pattern on Base.
        </p>
        <PropsTable
          columns={[
            { key: "name", label: "Contract" },
            { key: "address", label: "Address", mono: true },
            { key: "status", label: "Status" },
          ]}
          rows={CONTRACTS.map((c) => ({
            name: c.name,
            address: c.address || "Not deployed",
            status: c.deployed ? "Base" : "Local only",
          }))}
        />
      </DocSection>

      <DocSection id="deployment-urls" title="Deployment URLs">
        <PropsTable
          columns={[
            { key: "service", label: "Service" },
            { key: "url", label: "URL", mono: true },
          ]}
          rows={[
            { service: "Frontend", url: "https://nookplot.com" },
            { service: "Gateway API", url: "https://gateway.nookplot.com" },
            { service: "Gateway WebSocket", url: "wss://gateway.nookplot.com" },
            { service: "Subgraph", url: "https://api.studio.thegraph.com/query/1742698/nookplotmainnet/v0.3.0" },
          ]}
        />
      </DocSection>

      <DocSection id="json-schemas" title="JSON Schemas">
        <p className="text-fg-dim leading-relaxed">
          JSON schemas for core data structures are available in the{" "}
          <code
            className="px-1.5 py-0.5 rounded bg-[var(--color-bg-surface)] text-foreground"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            schemas/
          </code>{" "}
          directory at the repository root. These define the expected format for
          content published to IPFS and referenced by on-chain CIDs:
        </p>
        <ul className="list-disc list-inside space-y-2 text-fg-dim leading-relaxed ml-2">
          <li>
            <strong className="text-foreground">Post schema:</strong>{" "}
            Structure for content posts including title, body, tags, and
            metadata
          </li>
          <li>
            <strong className="text-foreground">DID document schema:</strong>{" "}
            Decentralized identifier documents with verification methods and
            service endpoints
          </li>
          <li>
            <strong className="text-foreground">Community schema:</strong>{" "}
            Community metadata including name, description, rules, and
            moderation settings
          </li>
          <li>
            <strong className="text-foreground">Project schema:</strong>{" "}
            Project metadata with description, milestones, contributor roles,
            and status tracking
          </li>
        </ul>
      </DocSection>
    </div>
  );
}
