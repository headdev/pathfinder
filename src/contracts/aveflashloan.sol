// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@aave/protocol-v2/contracts/interfaces/IFlashLoanReceiver.sol";
import "@aave/protocol-v2/contracts/flashloan/base/FlashLoanReceiverBase.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";

contract FlashLoanSwap is FlashLoanReceiverBase {
    address private owner;

    constructor(address _addressProvider) FlashLoanReceiverBase(_addressProvider) {
        owner = msg.sender;
    }

    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // Realizar el swap en Uniswap/SushiSwap
        IUniswapV2Router02 uniswapRouter = IUniswapV2Router02(YOUR_UNISWAP_ROUTER_ADDRESS);
        
        // Aprobar tokens para el router de Uniswap
        IERC20(assets[0]).approve(address(uniswapRouter), amounts[0]);

        address[] memory path = new address[](2);
        path[0] = assets[0];
        path[1] = assets[1];

        // Realizar el swap
        uniswapRouter.swapExactTokensForTokens(
            amounts[0],
            0,
            path,
            address(this),
            block.timestamp + 300
        );

        // Repagar el préstamo con la comisión
        uint256 amountOwing = amounts[0] + premiums[0];
        IERC20(assets[0]).approve(address(LENDING_POOL), amountOwing);

        return true;
    }

    function initiateFlashLoan(address asset, uint256 amount, address tokenOut) external {
        require(msg.sender == owner, "Only owner can initiate flash loan");

        address receiverAddress = address(this);
        address[] memory assets = new address[](1);
        assets[0] = asset;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        uint256[] memory modes = new uint256[](1);
        modes[0] = 0; // 0 = no debt (flash loan)

        address onBehalfOf = address(this);
        bytes memory params = ""; // Additional parameters if needed
        uint16 referralCode = 0;

        LENDING_POOL.flashLoan(
            receiverAddress,
            assets,
            amounts,
            modes,
            onBehalfOf,
            params,
            referralCode
        );
    }
}
