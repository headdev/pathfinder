const { ethers } = require('ethers');
const {
  QUOTER_CONTRACT_ADDRESS,
  UNISWAP_V2_SUSHSISWAP_ABI,
  ROUTER_ADDRESS_OBJECT,
} = require('../constants');

const { verfiy_token_path } = require('./utlis');
const Quoter = require('@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json');
const { abi: QuoterABI } = require('@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json');


// Asegúrate de que esta URL esté configurada correctamente
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const quoterContract = new ethers.Contract(QUOTER_CONTRACT_ADDRESS, QuoterABI, provider);
const INFURA_URL_VETTING_KEY = 'https://polygon.meowrpc.com';

//const provider = new ethers.JsonRpcProvider(INFURA_URL_VETTING_KEY);

export async function get_amount_out_from_uniswap_V3(params, amount) {
  try {
    console.log('Entering get_amount_out_from_uniswap_V3');
    console.log('Params:', JSON.stringify(params, null, 2));
    console.log('Amount:', amount);

    const {
      token_in,
      token_out,
      fee,
    } = params;

    console.log('QUOTER_CONTRACT_ADDRESS:', QUOTER_CONTRACT_ADDRESS);

    if (!QUOTER_CONTRACT_ADDRESS) {
      throw new Error('QUOTER_CONTRACT_ADDRESS is not defined');
    }

    console.log('Quoter contract address:', quoterContract.address);

    const amountIn = ethers.parseUnits(amount, 18);

    console.log('Calling quoteExactInputSingle with params:', {
      tokenIn: token_in,
      tokenOut: token_out,
      fee: Number(fee),
      amountIn: amountIn.toString(),
      sqrtPriceLimitX96: 0
    });

    const quotedAmountOut = await quoterContract.quoteExactInputSingle.staticCall(
      token_in,
      token_out,
      Number(fee),
      amountIn,
      0
    );

    console.log('quotedAmountOut:', quotedAmountOut.toString());

    const result = ethers.formatUnits(quotedAmountOut, 18);
    console.log('Formatted result:', result);

    return result;
  } catch (error) {
    console.error('Error in get_amount_out_from_uniswap_V3:', error);
    return '0';
  }
}

async function get_amount_out_from_uniswap_V2_and_sushiswap(
  liquidity_pool,
  amount
) {
  try {
    console.log('Entering get_amount_out_from_uniswap_V2_and_sushiswap');
    console.log('Liquidity pool:', JSON.stringify(liquidity_pool, null, 2));
    console.log('Amount:', amount);

    const {
      token0,
      token1,
      exchange,
      token_in,
      token_out,
    } = liquidity_pool;

    const token_in_decimals =
      token_in === token0.id ? token0.decimals : token1.decimals;
    const token_out_decimals =
      token_out === token1.id ? token1.decimals : token0.decimals;

    const poolContract = new ethers.Contract(
      ROUTER_ADDRESS_OBJECT[exchange],
      UNISWAP_V2_SUSHSISWAP_ABI,
      provider
    );

    const amouunt_in_parsed_big_int = ethers.parseUnits(
      amount,
      token_in_decimals
    );

    console.log('Calling getAmountsOut with params:', {
      amountIn: amouunt_in_parsed_big_int.toString(),
      path: [token_in, token_out]
    });

    const amount_out_from_trade = await poolContract.getAmountsOut.staticCall(
      amouunt_in_parsed_big_int,
      [token_in, token_out]
    );

    console.log('amount_out_from_trade:', amount_out_from_trade.toString());

    const parsed_amounts_out = ethers.formatUnits(
      amount_out_from_trade[1],
      token_out_decimals
    );

    console.log('parsed_amounts_out:', parsed_amounts_out);

    return parsed_amounts_out;
  } catch (error) {
    console.error('Error in get_amount_out_from_uniswap_V2_and_sushiswap:', error);
    throw error;
  }
}

async function on_chain_check(path_object) {
  try {
    const { path, loan_pools, optimal_amount } = path_object;
    verfiy_token_path(path);

    const loan_pool = loan_pools[path[0].token_in];
 
    if (loan_pool) {
      let input_amount = optimal_amount;
      const start_amount = optimal_amount;

      for (const pool of path) {
        const token_in_decimals =
          pool.token_in === pool.token0.id
            ? pool.token0.decimals
            : pool.token1.decimals;

        input_amount = Number(input_amount).toFixed(token_in_decimals);

        if (pool.exchange === 'uniswapV3') {
          const amounts_out = await get_amount_out_from_uniswap_V3(
            pool,
            input_amount.toString()
          );
          input_amount = amounts_out;
        } else {
          const amounts_out =
            await get_amount_out_from_uniswap_V2_and_sushiswap(
              pool,
              input_amount.toString()
            );
          input_amount = amounts_out;
        }
      }

      const borrow_token_usd_price =
        path[0].token_in === loan_pool.token0.id
          ? loan_pool.token_0_usd_price
          : loan_pool.token_1_usd_price;

      const profit = (Number(input_amount) - Number(start_amount)) * borrow_token_usd_price;
   
      path_object.profit_usd_onchain_check = profit;
      path_object.ending_amount = Number(input_amount) - Number(start_amount);
    }
  } catch (error) {
    console.error('Error in on_chain_check:', error);
  }
}

module.exports = { 
  on_chain_check, 
  get_amount_out_from_uniswap_V3, 
  get_amount_out_from_uniswap_V2_and_sushiswap 
};
