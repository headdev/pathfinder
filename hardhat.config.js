const fs = require('fs');
require("hardhat-deploy");
require("@tenderly/hardhat-tenderly");
require("hardhat-contract-sizer");
require("hardhat-dependency-compiler");
// Any file that has require('dotenv').config() statement 
// will automatically load any variables in the root's .env file.
require('dotenv').config();

const PRIVATE_KEY = process.env.PRIVATE_KEY
const etherscanKey = process.env.BSSCAN_KEY
const infraKey = process.env.INFRA_KEY



const endpointUrl = "https://polygon-rpc.com";
const privateKey = "d882a8e7320b84e38691b8028991959c11c4eeca4b2f6cc945a922aaa9e5d7f5";

module.exports = {
  defaultNetwork: "polygon",
  networks: {
    bsc: {
      url: "https://bsc-dataseed.binance.org/",
      accounts: [PRIVATE_KEY],
      // gasPrice: 20000000000,
      gas: 6000000,
    },
    polygon: {
      url: endpointUrl,
      accounts: [privateKey],
      //url: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
      //accounts: process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] :[],
      //url: "https://polygon-rpc.com",
      //accounts: [PRIVATE_KEY],
      gasPrice: 20000000000,
      gas: 6000000,
    },
    hardhat: {
      allowUnlimitedContractSize: true,
      chainId: 31337,
      gasPrice: 20000000000,
      gas: 6000000,
    },
    
  },
  solidity: {
    compilers: [
      {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 2000000,
          },
          viaIR: true
        },
      },
      {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 2000000,
            details: {
              yul: true,
              yulDetails: {
                stackAllocation: true,
                optimizerSteps: "dhfoDgvulfnTUtnIf"
              }
            }
          },
          viaIR: true
        },
      },]
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
 
  etherscan: {
    apiKey: etherscanKey,
  },
  preprocess: {
    eachLine: (hre) => ({
      transform: (line) => {
        if (line.match(/^\s*import /i)) {
          getRemappings().forEach(([find, replace]) => {
            if (line.match(find)) {
              line = line.replace(find, replace);
            }
          });
        }
        return line;
      },
    }),
  },
}