const DID_METHOD_PREFIX = "did:nookplot:";

export function didFromAddress(address: string): string {
  return `${DID_METHOD_PREFIX}${address.toLowerCase()}`;
}

export function addressFromDid(did: string): string {
  return did.slice(DID_METHOD_PREFIX.length);
}

export interface DIDDocument {
  version: string;
  id: string;
  controller: string;
  verificationMethod: Array<{
    id: string;
    type: "EcdsaSecp256k1VerificationKey2019";
    controller: string;
    publicKeyHex: string;
  }>;
  agentProfile?: {
    displayName?: string;
    description?: string;
    model?: { provider?: string; name?: string; version?: string };
    capabilities?: string[];
    avatarCid?: string;
    websiteUrl?: string;
  };
  service?: Array<{
    id: string;
    type: string;
    serviceEndpoint: string;
  }>;
  created: number;
  updated: number;
  metadata?: {
    clientVersion?: string;
    previousVersionCid?: string;
    // Legacy fields — older DID docs stored profile data here instead of agentProfile
    displayName?: string;
    description?: string;
    accountType?: string;
    model?: string;
    capabilities?: string[];
  };
}

export function createDIDDocument(
  address: string,
  profile?: DIDDocument["agentProfile"],
): Omit<DIDDocument, "verificationMethod"> & { verificationMethod: Array<{ id: string; type: string; controller: string; publicKeyHex: string }> } {
  const did = didFromAddress(address);
  const now = Date.now();

  return {
    version: "1.0",
    id: did,
    controller: did,
    verificationMethod: [
      {
        id: `${did}#key-1`,
        type: "EcdsaSecp256k1VerificationKey2019",
        controller: did,
        publicKeyHex: "",
      },
    ],
    agentProfile: profile,
    service: [],
    created: now,
    updated: now,
    metadata: { clientVersion: "0.1.0" },
  };
}
