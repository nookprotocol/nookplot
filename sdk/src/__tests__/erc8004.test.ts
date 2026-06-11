import { describe, it, expect, vi } from "vitest";
import { ethers } from "ethers";
import { ERC8004Manager } from "../erc8004.js";
import type { DIDDocument } from "../types.js";

const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const TEST_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

function makeManager(): ERC8004Manager {
  const provider = {
    getBlockNumber: vi.fn().mockResolvedValue(1n),
  } as unknown as ethers.JsonRpcProvider;

  const signer = new ethers.Wallet(TEST_PRIVATE_KEY);

  const ipfs = {
    uploadJson: vi
      .fn()
      .mockResolvedValue({ cid: "QmTestMetadataCid" }),
    getGatewayUrl: (cid: string) =>
      `https://gateway.pinata.cloud/ipfs/${cid}`,
  };

  return new ERC8004Manager(
    provider,
    signer,
    { identityRegistry: IDENTITY_REGISTRY },
    ipfs as never,
  );
}

function makeDID(overrides: Partial<DIDDocument> = {}): DIDDocument {
  return {
    version: "1.0",
    id: `did:nookplot:${TEST_ADDRESS}`,
    controller: TEST_ADDRESS,
    verificationMethod: [
      {
        id: `did:nookplot:${TEST_ADDRESS}#key-1`,
        type: "EcdsaSecp256k1VerificationKey2019",
        controller: `did:nookplot:${TEST_ADDRESS}`,
        publicKeyHex: TEST_ADDRESS,
      },
    ],
    agentProfile: {
      displayName: "Test Agent",
      description: "An agent used for testing the v1.1 metadata schema.",
      capabilities: ["test-capability-a", "test-capability-b"],
    } as never,
    created: 1700000000000,
    updated: 1700000000000,
    ...overrides,
  };
}

describe("ERC8004Manager.formatRegistrationMetadata — v1.1 SIWA-compatible schema", () => {
  const didCid = "QmDidDocumentCid";
  const gatewayUrl = `https://gateway.pinata.cloud/ipfs/${didCid}`;

  it("writes version 1.1", () => {
    const manager = makeManager();
    const metadata = manager.formatRegistrationMetadata(
      makeDID(),
      didCid,
      gatewayUrl,
    );
    expect(metadata.version).toBe("1.1");
  });

  it("sets active to true at mint time", () => {
    const manager = makeManager();
    const metadata = manager.formatRegistrationMetadata(
      makeDID(),
      didCid,
      gatewayUrl,
    );
    expect(metadata.active).toBe(true);
  });

  it("includes a services array with a web entry pointing at nookplot.xyz", () => {
    const manager = makeManager();
    const metadata = manager.formatRegistrationMetadata(
      makeDID(),
      didCid,
      gatewayUrl,
    );
    expect(metadata.services).toBeDefined();
    expect(metadata.services).toHaveLength(1);
    const svc = metadata.services![0];
    expect(svc.name).toBe("web");
    expect(svc.endpoint).toBe(
      `https://nookplot.xyz/agent/${TEST_ADDRESS}`,
    );
    expect(svc.version).toBe("1.0");
  });

  it("declares reputation as a supported trust model", () => {
    const manager = makeManager();
    const metadata = manager.formatRegistrationMetadata(
      makeDID(),
      didCid,
      gatewayUrl,
    );
    expect(metadata.supportedTrust).toEqual(["reputation"]);
  });

  it("sets the SIWA-compliant x402Support field (not x402Enabled)", () => {
    const manager = makeManager();
    const metadata = manager.formatRegistrationMetadata(
      makeDID(),
      didCid,
      gatewayUrl,
    );
    expect(metadata.x402Support).toBe(false);
    expect("x402Enabled" in metadata).toBe(false);
  });

  it("provides a per-agent image URL derived from the wallet address", () => {
    const manager = makeManager();
    const metadata = manager.formatRegistrationMetadata(
      makeDID(),
      didCid,
      gatewayUrl,
    );
    expect(metadata.image).toBe(
      `https://gateway.nookplot.com/v1/agent-image/${TEST_ADDRESS.toLowerCase()}.svg`,
    );
  });

  it("preserves the Nookplot-specific fields (platform, nookplotDid, didDocumentCid, walletAddress)", () => {
    const manager = makeManager();
    const did = makeDID();
    const metadata = manager.formatRegistrationMetadata(
      did,
      didCid,
      gatewayUrl,
    );
    expect(metadata.platform).toBe("nookplot");
    expect(metadata.nookplotDid).toBe(did.id);
    expect(metadata.didDocumentCid).toBe(didCid);
    expect(metadata.didDocumentUrl).toBe(gatewayUrl);
    expect(metadata.walletAddress).toBe(TEST_ADDRESS);
  });

  it("uses fallback name and description when agentProfile is omitted", () => {
    const manager = makeManager();
    const metadata = manager.formatRegistrationMetadata(
      makeDID({ agentProfile: undefined }),
      didCid,
      gatewayUrl,
    );
    expect(metadata.name).toBe("Nookplot Agent");
    expect(metadata.description).toContain("Nookplot");
    expect(metadata.capabilities).toEqual([]);
  });

  it("pulls name, description, capabilities from agentProfile when present", () => {
    const manager = makeManager();
    const metadata = manager.formatRegistrationMetadata(
      makeDID(),
      didCid,
      gatewayUrl,
    );
    expect(metadata.name).toBe("Test Agent");
    expect(metadata.description).toContain("v1.1 metadata schema");
    expect(metadata.capabilities).toEqual([
      "test-capability-a",
      "test-capability-b",
    ]);
  });

  it("created and updated timestamps are set to the same instant at mint", () => {
    const manager = makeManager();
    const metadata = manager.formatRegistrationMetadata(
      makeDID(),
      didCid,
      gatewayUrl,
    );
    expect(metadata.created).toBe(metadata.updated);
    expect(typeof metadata.created).toBe("number");
  });
});
