// SPDX-License-Identifier: GPL-3.0

// Following the principle of https://github.com/hoprnet/HOPR-Genesis-DAO/blob/main/gHOP.sol

pragma solidity ^0.6.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestDai is ERC20("Test DAI Token", "TDai") {
    /**
     * @dev Initializes the contract in paused state.
     * @param airdropRecipient Airdrop some tokens to the recipient
     */
    constructor(address airdropRecipient) public {
        _mint(airdropRecipient, 500000 ether);
    }

    function _beforeTokenTransfer(address from, address to, uint256 amount) internal override(ERC20) {}

    /**
     * @dev Allows the owner to mint tokens for one recipient.
     * @param account the beneficiary getting tokens
     * @param amount the amount of tokens that the beneficiary gets
     */
    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    /**
     * @dev Batch mint for some holders
     */
    function batchMint(address[] calldata accounts, uint256[] calldata amounts) external {
        require(accounts.length == amounts.length, "LENGTH_MISMATCH");
        for (uint256 i = 0; i < amounts.length; i++) {
            _mint(accounts[i], amounts[i]);
        }
    }
}