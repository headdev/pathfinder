const { ethers } = require('ethers');
const {
  QUOTER_CONTRACT_ADDRESS,
  UNISWAP_V2_SUSHSISWAP_ABI,
  ROUTER_ADDRESS_OBJECT,
} = require('../constants');

const { verfiy_token_path } = require('./utlis');
const Quoter = require('@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json');
const { abi: QuoterABI } = require('@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json');
const INFURA_URL_VETTING_KEY = 'https://polygon.meowrpc.com';

const provider = new ethers.JsonRpcProvider(INFURA_URL_VETTING_KEY);




async function get_amount_out_from_uniswap_V3(liquidity_pool, amount) {
  try {
    console.log('Entering get_amount_out_from_uniswap_V3');
    console.log('Liquidity pool:', JSON.stringify(liquidity_pool, null, 2));
    console.log('Amount:', amount);

    const {
      token0,
      token1,
      token_in,
      token_out,
      fee,
    } = liquidity_pool;

    const token_in_decimals =
      token_in === token0.id ? token0.decimals : token1.decimals;
    const token_out_decimals =
      token_out === token0.id ? token0.decimals : token1.decimals;

    console.log('QUOTER_CONTRACT_ADDRESS:', QUOTER_CONTRACT_ADDRESS);

    if (!QUOTER_CONTRACT_ADDRESS) {
      throw new Error('QUOTER_CONTRACT_ADDRESS is not defined');
    }

    const uniswap_V3_quoter_contract = new ethers.Contract(
      QUOTER_CONTRACT_ADDRESS,
      QuoterABI,
      provider
    );

    console.log('uniswap_V3_quoter_contract created');
    console.log('Contract address:', uniswap_V3_quoter_contract.address);
    console.log('Contract functions:', Object.keys(uniswap_V3_quoter_contract.functions));

    const amouunt_in_parsed_big_int = ethers.parseUnits(
      amount.toString(),
      token_in_decimals
    );

    console.log('Calling quoteExactInputSingle with params:', {
      tokenIn: token_in,
      tokenOut: token_out,
      fee: Number(fee),
      amountIn: amouunt_in_parsed_big_int.toString(),
      sqrtPriceLimitX96: 0
    });

    const quotedAmountOut = await uniswap_V3_quoter_contract.quoteExactInputSingle.staticCall(
      token_in,
      token_out,
      Number(fee),
      amouunt_in_parsed_big_int,
      0
    );

    console.log('quotedAmountOut:', quotedAmountOut.toString());

    const parsed_amounts_out = ethers.formatUnits(
      quotedAmountOut,
      token_out_decimals
    );

    console.log('parsed_amounts_out:', parsed_amounts_out);

    return parsed_amounts_out;
  } catch (error) {
    console.error('Error in get_amount_out_from_uniswap_V3:', error);
    if (error.message.includes('execution reverted')) {
      console.error('Contract execution reverted. This could be due to insufficient liquidity or other on-chain issues.');
    }
    throw error;  // Re-throw the error to be handled by the calling function
  }
}

async function get_amount_out_from_uniswap_V2_and_sushiswap(
  liquidity_pool,
  amount
) {
  try {
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

    const amount_out_from_trade = await poolContract.callStatic.getAmountsOut(
      amouunt_in_parsed_big_int,
      [token_in, token_out]
    );

    const parsed_amounts_out = ethers.formatUnits(
      amount_out_from_trade[1],
      token_out_decimals
    );

    return parsed_amounts_out;
  } catch (error) {
    console.error(error);
  }
}

async function on_chain_check(path_object) {
  try {
    const { path, loan_pools, optimal_amount } = path_object;
    verfiy_token_path(path);

    const loan_pool = loan_pools[path[0].token_in];
 
    const borrow_token_usd_price =
      path[0].token_in === loan_pool.token0.id
        ? loan_pool.token_0_usd_price
        : loan_pool.token_1_usd_price;

    /*/if (loan_pool) {
      const start_amount = optimal_amount;
      let input_amount = optimal_amount;/*/

      if (loan_pool) {
        let minAmountToInvest = optimal_amount;
        let maxAmountToTrade = Infinity;

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
      const profit = (input_amount - start_amount) * borrow_token_usd_price;
   
      path_object.profit_usd_onchain_check = profit;
      path_object.ending_amount = input_amount - start_amount;
    }
  } catch (error) {
    console.error(error);
  }
}

module.exports = { 
  on_chain_check, 
  get_amount_out_from_uniswap_V3, 
  get_amount_out_from_uniswap_V2_and_sushiswap 
};
