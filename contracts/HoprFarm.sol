// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.6.0;

import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Arrays.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC777/IERC777Recipient.sol";
import "@openzeppelin/contracts/introspection/IERC1820Registry.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * 5 million HOPR tokens are allocated as incentive for liquidity providers on uniswap.
 * This incentive will be distributed on an approx. weekly-basis over 3 months (13 weeks) 
 * Liquidity providers (LPs) can deposit their LP-tokens (UniswapV2Pair token for HOPR-DAI)
 * to this HoprFarm contract for at least 1 week (minimum deposit period) to receive rewards. 
 */
contract HoprFarm is IERC777Recipient, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;
    using Arrays for uint256[];

    uint256 public constant TOTAL_INCENTIVE = 5000000 ether;
    uint256 public constant WEEKLY_BLOCK_NUMBER = 44800; // Taking 13.5 s/block as average block time. thus 7*24*60*60/13.5 = 44800 blocks per week. 
    uint256 public constant TOTAL_CLAIM_PERIOD = 13; // Incentives are released over a period of 13 weeks. 
    uint256 public constant WEEKLY_INCENTIVE = 384615384615384615384615; // 5000000/13 weeks There is very small amount of remainder
    // uint256 public constant WEEKLY_INCENTIVE_LAST = 384615384615384615384620; //
    // setup ERC1820
    IERC1820Registry private constant ERC1820_REGISTRY = IERC1820Registry(0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24);
    bytes32 private constant TOKENS_RECIPIENT_INTERFACE_HASH = keccak256("ERC777TokensRecipient");

    struct LiquidityProvider {
        mapping(uint256=>uint256) eligibleBalance; // Amount of liquidity tokens
        uint256 stakeFrom;  // the first period where the liquidity provider starts to stake tokens
        uint256 claimedUntil; // the last period where the liquidity provider has claimed tokens
        uint256 currentBalance;
    }

    // an ascending block numbers of start/end of each farming interval. 
    // E.g. the first farming interval is [distributionBlocks[0], distributionBlocks[1]).
    uint256[] public distributionBlocks;
    mapping(uint256=>uint256) public eligibleLiquidityPerPeriod;
    mapping(address=>LiquidityProvider) public liquidityProviders;
    uint256 public totalPoolBalance;
    uint256 public claimedIncentive;
    address public multisig;
    IERC20 public pool; 
    IERC20 public hopr; 

    event TokenAdded(address indexed provider, uint256 indexed period, uint256 amount);
    event TokenRemoved(address indexed provider, uint256 indexed period, uint256 amount);
    event IncentiveClaimed(address indexed provider, uint256 indexed until, uint256 amount);

    /**
     * @dev Modifier to check address is multisig
     */
    modifier onlyMultisig(address adr) {
        require(adr == multisig, "HoprFarm: Only DAO multisig");
        _;
    }

    /**
     * @dev provides the farming schedule.
     * @param _pool address Address of the HOPR-DAI uniswap pool.
     * @param _token address Address of the HOPR token.
     * @param _multisig address Address of the HOPR DAO multisig.
     */
    constructor(address _pool, address _token, address _multisig) public {
        require(IUniswapV2Pair(_pool).token0() == _token || IUniswapV2Pair(_pool).token1() == _token, "HoprFarm: wrong token address");
        pool = IERC20(_pool);
        hopr = IERC20(_token);
        multisig = _multisig;
        distributionBlocks.push(0);
        ERC1820_REGISTRY.setInterfaceImplementer(address(this), TOKENS_RECIPIENT_INTERFACE_HASH, address(this));
    }

    /**
     * @dev ERC777 hook triggered when multisig send HOPR token to this contract.
     * @param operator address operator requesting the transfer
     * @param from address token holder address
     * @param to address recipient address
     * @param amount uint256 amount of tokens to transfer
     * @param userData bytes hex string of the starting block number. e.g. "0xb66bbd" for 11955133. It should not be longer than 3 bytes
     * @param operatorData bytes extra information provided by the operator (if any)
     */
    function tokensReceived(
        address operator,
        address from,
        address to,
        uint256 amount,
        bytes calldata userData,
        // solhint-disable-next-line no-unused-vars
        bytes calldata operatorData
    ) external override onlyMultisig(from) nonReentrant {
        require(msg.sender == address(hopr), "HoprFarm: Sender must be HOPR token");
        require(to == address(this), "HoprFarm: Must be sending tokens to HoprWrapper");
        require(amount == TOTAL_INCENTIVE, "HoprFarm: Only accept 5 million HOPR token");
        // take block number from userData, varies from 0x000000 to 0xffffff.
        // This value is sufficient as 0xffff will be in March 2023.
        require(userData.length == 3, "HoprFarm: Start block number needs to have three bytes");
        require(distributionBlocks[0] == 0, "HoprFarm: Not initialized yet.");
        bytes32 m;
        assembly {
            // it first loads the userData at the position 228 = 4 + 32 * 7, 
            // where 4 is the method signature and 7 is the storage of userData
            // Then bit shift the right-padded bytes32 to remove all the padded zeros
            // Given the blocknumber is not longer than 3 bytes, bitwise it needs to shift
            // log2(16) * (32 - 3) * 2 = 232
            m := shr(232, calldataload(228))
        }
        // update distribution blocks
        uint256 startBlock = uint256(m);
        require(startBlock >= block.number, "HoprFarm: Start block number should be in the future");
        distributionBlocks[0] = startBlock;
        for (uint256 i = 1; i <= TOTAL_CLAIM_PERIOD; i++) {
            distributionBlocks.push(startBlock + i * WEEKLY_BLOCK_NUMBER);
        }
    }

    /**
     * @dev Multisig can recover tokens (pool tokens/hopr tokens/any other random tokens)
     * @param token Address of the token to be recovered.
     */
    function recoverToken(address token) external onlyMultisig(msg.sender) nonReentrant {
        if (token == address(hopr)) {
            hopr.safeTransfer(multisig, hopr.balanceOf(address(this)).add(claimedIncentive).sub(TOTAL_INCENTIVE));
        } else if (token == address(pool)) {
            pool.safeTransfer(multisig, pool.balanceOf(address(this)).sub(totalPoolBalance));
        } else {
            IERC20(token).safeTransfer(multisig, IERC20(token).balanceOf(address(this)));
        }
    }

    /**
     * @dev Claim incenvtives for an account. Update total claimed incentive.
     * @param provider Account of liquidity provider
     */
    function claimFor(address provider) external nonReentrant {
        uint256 currentPeriod = distributionBlocks.findUpperBound(block.number);
        require(currentPeriod > 1, "HoprFarm: Too early to claim");
        // initial value should be 1
        uint256 claimedPeriod = liquidityProviders[provider].claimedUntil;
        require(claimedPeriod < currentPeriod, "HoprFarm: Already claimed");
        uint256 farmed;
        for (uint256 i = claimedPeriod; i < currentPeriod - 1; i++) {
            if (eligibleLiquidityPerPeriod[i] > 0) {
                farmed = farmed.add(WEEKLY_INCENTIVE.mul(liquidityProviders[provider].eligibleBalance[i]).div(eligibleLiquidityPerPeriod[i]));
            }
        }
        liquidityProviders[provider].claimedUntil = currentPeriod;
        claimedIncentive = claimedIncentive.add(farmed);
        // transfer farmed tokens to the provider
        hopr.safeTransfer(provider, farmed);
        emit IncentiveClaimed(provider, currentPeriod, farmed);
    }

    /**
     * @dev liquidity provider deposits their Uniswap HOPR-DAI tokens to the contract
     * It updates the current balance and the eligible farming balance
     * Thanks to `permit` function of UNI token (see below, link to source code), 
     * https://github.com/Uniswap/uniswap-v2-core/blob/master/contracts/UniswapV2ERC20.sol
     * LPs do not need to call `approve` seperately. `spender` is this farm contract. 
     * This function can be called by anyone with a valid signature of liquidity provider.
     * @param amount Amount of pool token to be staked into the contract. It is also the amount in the signature.
     * @param owner Address of the liquidity provider.
     * @param deadline Timestamp after which the signature is no longer valid.
     * @param v ECDSA signature.
     * @param r ECDSA signature.
     * @param s ECDSA signature.
     */
    function openFarmWithPermit(uint256 amount, address owner, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        IUniswapV2Pair(address(pool)).permit(owner, address(this), amount, deadline, v, r, s);
        _openFarm(amount, owner);
    }

    /**
     * @dev Called by liquidty provider to deposit their Uniswap HOPR-DAI tokens to the contract
     * It updates the current balance and the eligible farming balance
     * @param amount Amount of pool token to be staked into the contract.
     */
    function openFarm(uint256 amount) external nonReentrant {
        _openFarm(amount, msg.sender);
    }

    /**
     * @dev liquidity provider removes their Uniswap HOPR-DAI tokens to the contract
     * It updates the current balance and the eligible farming balance
     * @param amount Amount of pool token to be removed from the contract.
     */
    function closeFarm(uint256 amount) external nonReentrant {
        // update balance to the right phase
        uint256 currentPeriod = distributionBlocks.findUpperBound(block.number);
        // always add currentBalance
        uint256 newBalance = liquidityProviders[msg.sender].currentBalance.sub(amount);
        liquidityProviders[msg.sender].currentBalance = newBalance;
        totalPoolBalance = totalPoolBalance.sub(amount);      
        // update eligible balance
        updateEligibleBalance(msg.sender, newBalance, currentPeriod);
        // transfer token
        pool.transfer(msg.sender, amount);
        // emit event
        emit TokenRemoved(msg.sender, currentPeriod, amount);

    }

    /**
     * @dev returns the first index that contains a value greater or equal to the current `block.number`
     * If all numbers are strictly below block.number, returns array length.
     * @notice get the current farm period. 0 means "not started", 1 means "1st period", ...
     * If the returned value is larger than `maxFarmPeriod`, it means farming is "closed"
     */
    function currentFarmPeriod() public view returns (uint256) {
        return distributionBlocks.findUpperBound(block.number);
    }

    /**
     * @dev calculate virtual return based on current staking. Amount of tokens one can claim in the next period.
     * @param amountToStake Amount of pool token that a liquidity provider would stake
     */
    function currentFarmIncentive(uint256 amountToStake) public view returns (uint256) {
        uint256 currentPeriod = distributionBlocks.findUpperBound(block.number);
        return WEEKLY_INCENTIVE.mul(amountToStake).div(eligibleLiquidityPerPeriod[currentPeriod+1].add(amountToStake));
    }

    /**
     * @dev Get the total amount of incentive to be claimed by the liquidity provider.
     * @param provider Account of liquidity provider
     */
    function incentiveToBeClaimed(address provider) public view returns (uint256) {
        uint256 currentPeriod = distributionBlocks.findUpperBound(block.number);
        // initial value should be 1
        uint256 claimedPeriod = liquidityProviders[provider].claimedUntil;
        // It's too early to claim for a new period.
        if (currentPeriod < 1 || claimedPeriod >= currentPeriod) {
            return 0;            
        }
        uint256 farmed;
        for (uint256 i = claimedPeriod; i < currentPeriod - 1; i++) {
            if (eligibleLiquidityPerPeriod[i] > 0) {
                farmed = farmed.add(WEEKLY_INCENTIVE.mul(liquidityProviders[provider].eligibleBalance[i]).div(eligibleLiquidityPerPeriod[i]));
            }
        }
        return farmed;
    }

    /**
     * @dev update the liquidity token balance, of which is used for calculating the result of farming
     * It updates the balance for the following periods. For the previous period, if the balance reduces 
     * the eligible balance of the previous round reduces. If the balance increases, it only affects the
     * following rounds.
     * @param account Address of the liquidity provider
     * @param newBalance Latest balance
     * @param currentPeriod Index of the farming period at current block number.
     */
    function updateEligibleBalance(address account, uint256 newBalance, uint256 currentPeriod) internal {
        if (currentPeriod > 0) {
            uint256 balanceFromLastPeriod = liquidityProviders[account].eligibleBalance[currentPeriod - 1];
            if (balanceFromLastPeriod > newBalance) {
                liquidityProviders[account].eligibleBalance[currentPeriod - 1] = newBalance;
                eligibleLiquidityPerPeriod[currentPeriod - 1] = eligibleLiquidityPerPeriod[currentPeriod - 1].sub(balanceFromLastPeriod).add(newBalance);
            }
        }
        uint256 newEligibleLiquidityPerPeriod = eligibleLiquidityPerPeriod[currentPeriod].sub(liquidityProviders[account].eligibleBalance[currentPeriod]).add(newBalance);
        for (uint256 i = currentPeriod; i <= TOTAL_CLAIM_PERIOD; i++) {
            liquidityProviders[account].eligibleBalance[i] = newBalance;
            eligibleLiquidityPerPeriod[i] = newEligibleLiquidityPerPeriod;
        }
    }

    /**
     * @dev liquidity provider deposits their Uniswap HOPR-DAI tokens to the contract
     * It updates the current balance and the eligible farming balance
     * @param amount Amount of pool token to be staked into the contract.
     * @param provider Address of the liquidity provider.
     */
    function _openFarm(uint256 amount, address provider) internal {
        // update balance to the right phase
        uint256 currentPeriod = distributionBlocks.findUpperBound(block.number);
        require(currentPeriod <= TOTAL_CLAIM_PERIOD, "HoprFarm: Farming ended");
        // always add currentBalance
        uint256 newBalance = liquidityProviders[provider].currentBalance.add(amount);
        liquidityProviders[provider].currentBalance = newBalance;
        totalPoolBalance = totalPoolBalance.add(amount);      
        // update eligible balance
        updateEligibleBalance(provider, newBalance, currentPeriod);
        // transfer token
        pool.safeTransferFrom(provider, address(this), amount);
        // emit event
        emit TokenAdded(provider, currentPeriod, amount);
    }
}