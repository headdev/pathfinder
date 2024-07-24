// scripts/swap.js
const { ethers } = require("hardhat");
require("dotenv").config();

const sushiSwapAddress = "0x9Cd3011Ed0D3B7dE09eC448AC3457D4968394A11"; // Dirección del contrato desplegado

const tokenIn = "0x7b79995e5f793a07bc00c21412e50ecae098e7f9"; // Dirección de WETH en Sepolia
const tokenOut = "0xf08a50178dfcde18524640ea6618a1f965821715"; // Dirección de USDC en Sepolia


async function main() {

  const [deployer] = await ethers.getSigners();
  const sushiSwap = await ethers.getContractAt("SushiSwap", sushiSwapAddress, deployer);

  const amountIn = ethers.parseUnits("0.001", 18); // 0.10% de 1 ETH
  const to = deployer.address;

  // Obtener el gas price actual
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice;

  // const gasPrice = await ethers.provider.getGasPrice();

  //const gasPrice = ethers.parseUnits('30', 'gwei'); //
  console.log('gasPrice', gasPrice);


  const tx = await sushiSwap.swap(tokenIn, tokenOut, amountIn, to, {
    gasLimit: 2000000, //ethers.hexlify(3000000), //ethers.hexlify(550000), // Ajusta según sea necesario
    gasPrice: gasPrice
  });
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block", receipt.blockNumber);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });