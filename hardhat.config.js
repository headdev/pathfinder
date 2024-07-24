const fs = require('fs');
require("hardhat-deploy");
require("@tenderly/hardhat-tenderly");
require("hardhat-contract-sizer");
require("hardhat-dependency-compiler");
// Any file that has require('dotenv').config() statement 
// will automatically load any variables in the root's .env file.
require('dotenv').config();


const etherscanKey = process.env.BSSCAN_KEY
const infraKey = process.env.INFRA_KEY

require("dotenv").config();

const { API_URL, PRIVATE_KEY } = process.env;

console.log('process.env.PRIVATE_KEY', PRIVATE_KEY);
/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 2000000,
          },
          viaIR: false
        },
      },
      {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 2000000,
          },
          viaIR: false
        },
      },]
  },
  
  networks: {
    mumbai: {
      url: "https://polygon-rpc.com",
      accounts: [PRIVATE_KEY],
    },

    main: {
      url: API_URL,
      accounts: [PRIVATE_KEY],
    },

    sepolia: {
      url: "https://sepolia.infura.io/v3/e4d30db3a5a34044a005ab662061684",
      accounts: [PRIVATE_KEY],
      chainId:11155111,
    }
  
  }
};