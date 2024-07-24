// test:

it("Swap should work", async () => {
    // Sushiswap router address in mainnet
    const sushiswapRouterAddress = "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f"
  
    const SwapAggregator = await ethers.getContractFactory("SwapAggregator");
    const swapAggregator = await SwapAggregator.deploy(sushiswapRouterAddress);
  
    const tx = await swapAggregator.swap(sushiswapId, USDC, 1000000)
    // validate tx receipt
  })