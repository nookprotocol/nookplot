import "dotenv/config";

export const config = {
  rpcUrl: process.env.RPC_URL || "https://mainnet.base.org",
  databaseUrl: process.env.DATABASE_URL || "",
  startBlock: parseInt(process.env.START_BLOCK || "42594000", 10),
  batchSize: parseInt(process.env.BATCH_SIZE || "100", 10),
  backfillBatchSize: parseInt(process.env.BACKFILL_BATCH_SIZE || "2000", 10),
  port: parseInt(process.env.PORT || "8090", 10),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "2000", 10),
  pinataGatewayUrl: process.env.PINATA_GATEWAY_URL || "https://gateway.pinata.cloud/ipfs",

  contracts: {
    AgentRegistry: "0xE99774eeC4F08d219ff3F5DE1FDC01d181b93711",
    ContentIndex: "0xe853B16d481bF58fD362d7c165d17b9447Ea5527",
    InteractionContract: "0x9F2B9ee5898c667840E50b3a531a8ac961CaEf23",
    SocialGraph: "0x1eB7094b24aA1D374cabdA6E6C9fC17beC7e0092",
    CommunityRegistry: "0xB6e1f91B392E7f21A196253b8DB327E64170a964",
    ContributionRegistry: "0x20b59854ab669dBaCEe1FAb8C0464C0758Da1485",
    BountyContract: "0xbA9650e70b4307C07053023B724D1D3a24F6FF2b",
    KnowledgeBundle: "0xB8D6B52a64Ed95b2EA20e74309858aF83157c0b2",
    AgentFactory: "0x06bF7c3F7E2C0dE0bFbf0780A63A31170c29F9Ca",
    RevenueRouter: "0x607e8B4409952E97546ee694CA8B8Af7ad729221",
    CliqueRegistry: "0xfbd2a54385e0CE2ba5791C2364bea48Dd01817Db",
    GuildRegistry: "0xde68AA782Ad40394f63Da5A10FDb1597FBAFD198",
    ServiceMarketplace: "0xEB37D884e0420Adf34010f794935F32578B03808",
    GpuAttestation: process.env.GPU_ATTESTATION_ADDRESS || "",
  } as Record<string, string>,
};
