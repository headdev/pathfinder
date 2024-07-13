// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface ISushiSwapRouter {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

interface IERC20 {
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract Arbitrage {
    address public owner;
    address public sushiSwapRouter = 0x0dc8E47a1196bcB590485eE8bF832c5c68A52f4B; // SushiSwap Router en Polygon

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not the contract owner");
        _;
    }

    function executeArbitrage(
        address token0,
        address token1,
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata pathBuy,
        address[] calldata pathSell
    ) external onlyOwner {
        // Transfer token0 from user to contract
        IERC20(token0).transferFrom(msg.sender, address(this), amountIn);
        IERC20(token0).approve(sushiSwapRouter, amountIn);

        // Buy token1 with token0 on SushiSwap
        uint256[] memory amountsBuy = ISushiSwapRouter(sushiSwapRouter).swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            pathBuy,
            address(this),
            block.timestamp
        );

        uint256 amountToken1Received = amountsBuy[amountsBuy.length - 1];

        // Approve token1 for selling on SushiSwap
        IERC20(token1).approve(sushiSwapRouter, amountToken1Received);

        // Sell token1 back to token0 on SushiSwap
        uint256[] memory amountsSell = ISushiSwapRouter(sushiSwapRouter).swapExactTokensForTokens(
            amountToken1Received,
            0,
            pathSell,
            address(this),
            block.timestamp
        );

        uint256 amountToken0Received = amountsSell[amountsSell.length - 1];

        // Ensure profit
        require(amountToken0Received > amountIn, "Arbitrage failed!");

        // Transfer profit back to owner
        IERC20(token0).transfer(msg.sender, amountToken0Received);
    }

    function withdrawTokens(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(msg.sender, balance);
    }
}
