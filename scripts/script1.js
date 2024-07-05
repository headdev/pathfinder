const hre = require("hardhat");

const { ethers } = require('hardhat')


async function getBalance(address) {
  const balance = await ethers.provider.getBalance(address)
  return balance  //hre.ethers.utils.formatEther(balance)
}

async function main() {

  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address, await getBalance(deployer.address));


  console.log("deploying...");
  const FlashLoan = await hre.ethers.getContractFactory("FlashLoan");
  const flashLoan = await FlashLoan.deploy(
  "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb"
  );

  //await flashLoan.deployed();

  console.log("Flash loan contract deployed: ", flashLoan.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});