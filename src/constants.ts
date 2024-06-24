enum DEX {
    UniswapV3,
    Sushiswap
}
const MIN_TVL = 50_000;
const DEFAULT_TIMEOUT = 5000; //ms
const DEFAULT_TOKEN_NUMBER = 5;
const SLIPPAGE = 0.005; // 0.5% slippage
const LENDING_FEE = 0.005; // 0.5% lending fee



export {
    DEX,
    MIN_TVL,
    DEFAULT_TIMEOUT,
    DEFAULT_TOKEN_NUMBER,
    SLIPPAGE,
    LENDING_FEE 
}