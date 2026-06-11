import "dotenv/config";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        // Lowered from 200 → 1 to keep BountyContract under the 24576-byte
        // EIP-170 limit after adding 7 multi-payout Open-mode functions + soft-fail
        // paths. Runtime-gas impact is negligible (contract bodies are dominated by
        // SSTOREs + ERC-20 calls, not arithmetic). Per-contract overrides do NOT
        // work when files share a solc version because Hardhat groups them into a
        // single compilation job, so this setting is applied globally.
        runs: 1,
      },
      // Enable Yul IR pipeline — shaves ~5-10% of bytecode size to keep
      // BountyContract under the 24576-byte EIP-170 limit. Other targets see
      // negligible runtime gas impact; Yul output is a superset of legacy.
      viaIR: true,
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: {
      // Local development network — free, instant, auto-mines blocks
      accounts: { count: 60 }, // Need >20 for moderator cap, >55 for collaborator cap tests
      // Fork config: enable via FORK=true to simulate mainnet upgrades locally.
      // NOTE: Hardhat EDR (Rust EVM) does NOT ship hardfork history for Base Mainnet
      // (chainId 8453, OP-stack). Forking against latest blocks will fail with
      // "No known hardfork for execution on historical block ... in chain with id 8453".
      // Tracked upstream: https://github.com/NomicFoundation/edr/issues/522
      // Workarounds: (1) wait for EDR to ship Base support, (2) use Foundry's `forge`,
      // (3) skip fork dry-run (comprehensive unit tests + pre-flight + smoke).
      ...(process.env.FORK === "true" && {
        hardfork: "shanghai",
        forking: {
          url: process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org",
          blockNumber: process.env.FORK_BLOCK
            ? parseInt(process.env.FORK_BLOCK)
            : undefined,
        },
      }),
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
      chainId: 84532,
    },
    baseMainnet: {
      url: process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org",
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
      chainId: 8453,
    },
  },
  etherscan: {
    apiKey: process.env.BASESCAN_API_KEY || "",
    customChains: [
      {
        network: "baseMainnet",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
      {
        network: "base-sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
    ],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
};

export default config;
