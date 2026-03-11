import { ethers, type LogDescription } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const abisDir = path.join(__dirname, "..", "abis");

export interface DecodedLog {
  contractName: string;
  eventName: string;
  parsed: LogDescription;
  address: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

interface TopicEntry {
  contractName: string;
  iface: ethers.Interface;
  fragment: ethers.EventFragment;
}

// Build lookup: topic0 → entry (one per contract, same topic0 can appear in multiple)
const topicMap = new Map<string, TopicEntry[]>();
const contractAddressToName = new Map<string, string>();
const allAddresses: string[] = [];

// Also expose interfaces for external use
export const interfaces = new Map<string, ethers.Interface>();

for (const [contractName, address] of Object.entries(config.contracts)) {
  const abiPath = path.join(abisDir, `${contractName}.json`);
  const raw = JSON.parse(fs.readFileSync(abiPath, "utf-8"));
  // Handle both plain ABI arrays and Hardhat artifact format ({ abi: [...] })
  const abi = Array.isArray(raw) ? raw : raw.abi;
  const iface = new ethers.Interface(abi);
  interfaces.set(contractName, iface);

  const lower = address.toLowerCase();
  contractAddressToName.set(lower, contractName);
  allAddresses.push(lower);

  for (const fragment of iface.fragments) {
    if (fragment.type !== "event") continue;
    const evFragment = fragment as ethers.EventFragment;
    const topic0 = iface.getEvent(evFragment.name)?.topicHash;
    if (!topic0) continue;

    const key = topic0.toLowerCase();
    const entries = topicMap.get(key) || [];
    entries.push({ contractName, iface, fragment: evFragment });
    topicMap.set(key, entries);
  }
}

export function getContractAddresses(): string[] {
  return allAddresses;
}

export function getAllTopic0s(): string[] {
  return [...topicMap.keys()];
}

export function decodeLogs(
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
    blockNumber: number;
    transactionHash: string;
    logIndex: number;
  }>,
): DecodedLog[] {
  const results: DecodedLog[] = [];

  for (const log of logs) {
    const addr = log.address.toLowerCase();
    const contractName = contractAddressToName.get(addr);
    if (!contractName) continue;

    const topic0 = log.topics[0]?.toLowerCase();
    if (!topic0) continue;

    const entries = topicMap.get(topic0);
    if (!entries) continue;

    // Find the entry for this specific contract
    const entry = entries.find((e) => e.contractName === contractName);
    if (!entry) continue;

    try {
      const parsed = entry.iface.parseLog({
        topics: log.topics,
        data: log.data,
      });
      if (!parsed) continue;

      results.push({
        contractName: entry.contractName,
        eventName: parsed.name,
        parsed,
        address: addr,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      });
    } catch {
      // Skip unparseable logs
    }
  }

  return results;
}
