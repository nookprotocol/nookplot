/**
 * Manual ServiceMarketplace deployment — bypasses OZ upgrades plugin
 * to work around "already known" transaction stuck in sequencer.
 *
 * Deploys implementation + ERC1967Proxy manually, then calls initialize.
 */

import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("================================================");
  console.log("  Nookplot — ServiceMarketplace (Manual Deploy)");
  console.log("================================================");
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Balance:   ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log(`Nonce:     ${await ethers.provider.getTransactionCount(deployer.address)}`);
  console.log("------------------------------------------------\n");

  const forwarderAddress = process.env.FORWARDER_ADDRESS;
  const agentRegistryAddress = process.env.AGENT_REGISTRY_ADDRESS;
  if (!forwarderAddress || !agentRegistryAddress) {
    throw new Error("Missing FORWARDER_ADDRESS or AGENT_REGISTRY_ADDRESS in .env");
  }

  const ownerAddress = deployer.address;
  const treasuryAddress = deployer.address;

  // 1. Deploy implementation with explicit gas to avoid estimation timeout
  console.log("1/3 Deploying ServiceMarketplace implementation...");
  const Factory = await ethers.getContractFactory("ServiceMarketplace");
  const impl = await Factory.deploy(forwarderAddress, {
    gasLimit: 5_000_000,
  });
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();
  console.log(`    ✔ Implementation: ${implAddress}`);

  // 2. Encode initialize call
  const initData = Factory.interface.encodeFunctionData("initialize", [
    ownerAddress,
    agentRegistryAddress,
    treasuryAddress,
  ]);

  // 3. Deploy ERC1967Proxy
  console.log("2/3 Deploying ERC1967Proxy...");
  const ProxyFactory = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"
  );
  const proxy = await ProxyFactory.deploy(implAddress, initData, {
    gasLimit: 1_000_000,
  });
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  console.log(`    ✔ Proxy:          ${proxyAddress}`);

  // 4. Verify
  console.log("3/3 Verifying...");
  const marketplace = Factory.attach(proxyAddress) as any;
  const owner = await marketplace.owner();
  const trusted = await marketplace.isTrustedForwarder(forwarderAddress);
  console.log(`    ✔ owner() = ${owner}`);
  console.log(`    ✔ isTrustedForwarder = ${trusted}`);

  console.log("\n================================================");
  console.log("  ServiceMarketplace Deployment Complete!");
  console.log("================================================");
  console.log(`\nSERVICE_MARKETPLACE_ADDRESS=${proxyAddress}`);
  console.log("\n================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
