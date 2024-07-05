const hre = require("hardhat");

async function main() {
  // Get the contract factory
  const FlashLoan = await hre.ethers.getContractFactory("FlashLoan");

  // Address of the Aave Pool Addresses Provider
  // This is the Goerli testnet address, change it for other networks
  const ADDRESSES_PROVIDER = "0x5E52dEc931FFb32f609681B8438A51c675cc232d";

  // Deploy the contract
  const flashLoan = await FlashLoan.deploy(ADDRESSES_PROVIDER);

  // Wait for deployment to finish
  await flashLoan.deployed();

  console.log("FlashLoan contract deployed to:", flashLoan.address);
}

// Run the deployment
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });