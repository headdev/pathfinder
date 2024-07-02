// exchange_utils.ts

import { ethers } from 'ethers';
import {
  UNISWAP_V2_SUSHSISWAP_ABI,
  ROUTER_ADDRESS_OBJECT,
  QUOTER_CONTRACT_ADDRESS,
  INFURA_URL_VETTING_KEY,
  MIN_USD_VALUE_FOR_OPTIMAL_INPUT_RANGE,
  MAX_USD_VALUE_FOR_OPTIMAL_INPUT_RANGE,
  STEP_BETWEEN_RANGE,
} from './constants';
import * as getLiquidityEntity from './uniswap_v3_math/get_liquidity';
import * as encodeSqrtRatioX96  from './uniswap_v3_math/utils';
import Quoter  from "@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json";

async function getOptimalAmountForUniswapV3Pool(pool, tokenIn, tokenOut) {
  const provider = new ethers.providers.JsonRpcProvider(INFURA_URL_VETTING_KEY);
  const tokenInDecimals = tokenIn.decimals;
  const tokenOutDecimals = tokenOut.decimals;

  const quoterContract = new ethers.Contract(
    QUOTER_CONTRACT_ADDRESS,
    Quoter.abi,
    provider
  );

  let optimalAmount = 0;
  let maxAmountOut = 0;

  for (let amount = MIN_USD_VALUE_FOR_OPTIMAL_INPUT_RANGE; amount <= MAX_USD_VALUE_FOR_OPTIMAL_INPUT_RANGE; amount += STEP_BETWEEN_RANGE) {
    const amountInBigInt = ethers.utils.parseUnits(amount.toString(), tokenInDecimals);

    const quotedAmountOut = await quoterContract.callStatic.quoteExactInputSingle(
      tokenIn.id,
      tokenOut.id,
      pool.fee,
      amountInBigInt,
      0
    );

    const amountOut = ethers.utils.formatUnits(quotedAmountOut, tokenOutDecimals);

    if (amountOut > maxAmountOut) {
      maxAmountOut = amountOut;
      optimalAmount = amount;
    }
  }

  const [token0Reserve, token1Reserve] = getAmountsForCurrentLiquidity(
    [tokenIn.decimals, tokenOut.decimals],
    pool.liquidity,
    pool.sqrtPriceX96,
    pool.tickSpacing
  );

  return {
    optimalAmount,
    token0Reserve,
    token1Reserve,
  };
}

async function getOptimalAmountForSushiswapPool(pool, tokenIn, tokenOut) {
  const provider = new ethers.providers.JsonRpcProvider(INFURA_URL_VETTING_KEY);
  const tokenInDecimals = tokenIn.decimals;
  const tokenOutDecimals = tokenOut.decimals;

  const poolContract = new ethers.Contract(
    ROUTER_ADDRESS_OBJECT.sushiswap,
    UNISWAP_V2_SUSHSISWAP_ABI,
    provider
  );

  let optimalAmount = 0;
  let maxAmountOut = 0;

  for (let amount = MIN_USD_VALUE_FOR_OPTIMAL_INPUT_RANGE; amount <= MAX_USD_VALUE_FOR_OPTIMAL_INPUT_RANGE; amount += STEP_BETWEEN_RANGE) {
    const amountInBigInt = ethers.utils.parseUnits(amount.toString(), tokenInDecimals);
    const amountOutBigInt = await poolContract.getAmountsOut(amountInBigInt, [tokenIn.id, tokenOut.id]);

    const amountOut = ethers.utils.formatUnits(amountOutBigInt[1], tokenOutDecimals);

    if (amountOut > maxAmountOut) {
      maxAmountOut = amountOut;
      optimalAmount = amount;
    }
  }

  const reserves = await poolContract.getReserves();
  const token0Reserve = ethers.utils.formatUnits(reserves[0], tokenIn.decimals);
  const token1Reserve = ethers.utils.formatUnits(reserves[1], tokenOut.decimals);

  return {
    optimalAmount,
    token0Reserve,
    token1Reserve,
  };
}

export { getOptimalAmountForUniswapV3Pool, getOptimalAmountForSushiswapPool };