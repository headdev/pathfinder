import { BigNumberish } from 'ethers';

export function get_amount_out_from_uniswap_V3(liquidity_pool: any, amount: string): Promise<string>;
export function get_amount_out_from_uniswap_V2_and_sushiswap(liquidity_pool: any, amount: string): Promise<string>;
export function on_chain_check(path_object: any): Promise<void>;