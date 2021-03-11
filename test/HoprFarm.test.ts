import * as factoryBuild from "@uniswap/v2-core/build/UniswapV2Factory.json";
import * as pairBuild from "@uniswap/v2-core/build/UniswapV2Pair.json";
import { ethers, network } from 'hardhat'
import { BigNumber, constants, Contract, Signer, utils } from 'ethers'
import { getParamFromTxResponse } from '../utils/events';
import{ expect } from "chai";
import { it } from 'mocha';
import { deployRegistry } from "../utils/registry";
import { deployFromBytecode, deployContract, deployContract3 } from "../utils/contracts";
import { advanceBlockTo } from "../utils/time";
import expectRevert from "../utils/exception";
import { getApprovalDigest, signTransactions } from "../utils/digest";

describe('HoprFarm', function () {
    let owner: Signer;
    let provider1: Signer;
    let provider2: Signer;
    let provider3: Signer;
    let ownerAddress: string;
    let provider1Address: string;
    let provider2Address: string;
    let provider3Address: string;
    let hoprToken: Contract
    let testDai: Contract
    let uniswapFactory: Contract;
    let uniPair: Contract;
    let hoprFarm: Contract;
    let erc1820: Contract;
  
    const period = Array.from(Array(14).keys());
    let claimBlocks;
  
    const reset = async () => {
        [owner, provider1, provider2, provider3] = await ethers.getSigners();
        ownerAddress = await owner.getAddress();
        provider1Address = await provider1.getAddress();
        provider2Address = await provider2.getAddress();
        provider3Address = await provider3.getAddress();

        uniswapFactory = await deployFromBytecode(owner, factoryBuild.abi, factoryBuild.bytecode, ownerAddress);

        // create and airdrop DAI
        testDai = await deployContract(owner, "TestDai", ownerAddress);
        await testDai.transfer(provider1Address, utils.parseEther("1000"));
        await testDai.transfer(provider2Address, utils.parseEther("2000"));
        await testDai.transfer(provider3Address, utils.parseEther("2000"));

        // create and airdrop HOPR
        erc1820 = await deployRegistry(owner);
        hoprToken = await deployContract(owner, "HoprToken", null);
        await hoprToken.connect(owner).grantRole(await hoprToken.MINTER_ROLE(), ownerAddress)
        await hoprToken.mint(ownerAddress, utils.parseEther("5001000"), "0x", "0x");
        await hoprToken.mint(provider1Address, utils.parseEther("1000"), "0x", "0x");
        await hoprToken.mint(provider2Address, utils.parseEther("2000"), "0x", "0x");
        await hoprToken.mint(provider3Address, utils.parseEther("2000"), "0x", "0x");
        
        // owner create Uni pair
        const tx = await uniswapFactory.connect(owner).createPair(testDai.address, hoprToken.address);
        const receipt = await ethers.provider.waitForTransaction(tx.hash);
        const adr = await getParamFromTxResponse(receipt, "PairCreated(address,address,address,uint256)", 5, uniswapFactory.address.toLowerCase(), "Create uniswap pair");
        uniPair = new ethers.Contract("0x"+adr.slice(26,66), pairBuild.abi, ethers.provider)
        
        // create farm contract
        hoprFarm = await deployContract3(owner, "HoprFarm", uniPair.address, hoprToken.address, ownerAddress);

        // -----logs
        console.table([
            ["Owner", ownerAddress],
            ["Provider 1", provider1Address],
            ["Provider 2", provider2Address],
            ["Provider 3", provider3Address],
            ["UniFactory", uniswapFactory.address],
            ["Hopr", hoprToken.address],
            ["Dai", testDai.address],
            ["UniPair", uniPair.address],
            ["HoprFarm", hoprFarm.address],
        ]);
    }

    const initialize = async () => {
        // initialize contract by providing 5 m HOPR and the starting blocknumber, starting block is 256
        await hoprToken.connect(owner).send(hoprFarm.address, utils.parseEther("5000000"), "0x000100");

        // potential liquidity providers give allowance, except for LP3
        await uniPair.connect(owner).approve(hoprFarm.address, constants.MaxUint256);
        await uniPair.connect(provider1).approve(hoprFarm.address, constants.MaxUint256);
        await uniPair.connect(provider2).approve(hoprFarm.address, constants.MaxUint256);
    }

    const provideLiquidity = async (signer: Signer, amount: string) => {
        const signerAddress = await signer.getAddress();
        await hoprToken.connect(signer).transfer(uniPair.address, utils.parseEther(amount));
        await testDai.connect(signer).transfer(uniPair.address, utils.parseEther(amount));
        await uniPair.connect(owner).mint(signerAddress);
    }

    const permitSignature = async (ownerIndex: number, amount: BigNumber|string, ddl?: BigNumber|number): Promise<{v:number, r:string, s:string}> => {
        const owner = (await ethers.getSigners())[ownerIndex];
        const ownerAddress = await owner.getAddress();
        const nonce = await uniPair.nonces(ownerAddress);
        const deadline = ddl ?? constants.MaxUint256;
        const digest = await getApprovalDigest(
          uniPair,
          { owner: ownerAddress, spender: hoprFarm.address, value: BigNumber.from(amount) },
          nonce,
          BigNumber.from(deadline)
        )
        
        // assuming the wallet is derived from mnemonic
        const ownerWallet = ethers.Wallet.fromMnemonic((network.config.accounts as any).mnemonic, `m/44'/60'/0'/0/${ownerIndex}`);
        const signingKey = new utils.SigningKey(ownerWallet.privateKey);
        const {v, r, s} =  await signTransactions(signingKey, digest)

        // using signing key
        return {v, r, s}
    }
  
    describe('integration tests', function () {
        before(async function () {
            await reset()
        })

        it('cannot be initialized by a non multisig', async function () {
            const randomHolder = (await ethers.getSigners())[4];
            const randomHolderAddress = await randomHolder.getAddress();
            // this holder has 5 million HOPR token
            await hoprToken.mint(randomHolderAddress, utils.parseEther("5000000"), "0x", "0x");
            expectRevert(hoprToken.connect(randomHolder).send(hoprFarm.address, utils.parseEther("5000000"), "0x000100"), "HoprFarm: Only DAO multisig")
        })

        it('cannot be initialized with a timestamp of different size', async function () {
            expectRevert(hoprToken.connect(owner).send(hoprFarm.address, utils.parseEther("5000000"), "0x00000100"), "HoprFarm: Start block number needs to have three bytes")
        })

        it('cannot be initialized with a timestamp in the past', async function () {
            expectRevert(hoprToken.connect(owner).send(hoprFarm.address, utils.parseEther("5000000"), "0x000001"), "HoprFarm: Start block number should be in the future")
        })

        it('cannot be initialized with differnt amount of incentive', async function () {
            expectRevert(hoprToken.connect(owner).send(hoprFarm.address, utils.parseEther("4000000"), "0x000100"), "HoprFarm: Only accept 5 million HOPR token")
        })

        it('initializes the farm by multisig', async function () {
            await initialize();
        })

        it('cannot be initialized again by the multisig', async function () {
            const randomHolder = (await ethers.getSigners())[4];
            const randomHolderAddress = await randomHolder.getAddress();

            const FIVE_MILLION = utils.parseEther("5000000");
            await hoprToken.connect(randomHolder).transfer(ownerAddress, FIVE_MILLION);
            expectRevert(hoprToken.connect(owner).send(hoprFarm.address, utils.parseEther("5000000"), "0x000100"), "HoprFarm: Not initialized yet.")
            // send those tokens back to random holder
            await hoprToken.connect(owner).transfer(randomHolderAddress, FIVE_MILLION);
        })

        it('provides the first liquidity from owner (100 HOPR and 100 DAI)', async function () {
            expect((await uniPair.balanceOf(ownerAddress)).toString()).to.equal(constants.Zero.toString()); 
            // add 100 HOPR and 100 Dai to the contract
            await provideLiquidity(owner, "100");
            const liquidity = await uniPair.balanceOf(ownerAddress);
            expect(liquidity.toString()).to.equal(utils.parseEther("100").sub(BigNumber.from(1000)).toString());
        })

        it('can receive ERC777 on HoprFarm contract', async function () {
            const interfaceHash = utils.keccak256(utils.toUtf8Bytes('ERC777TokensRecipient'));
            const implementer = await erc1820.getInterfaceImplementer(hoprFarm.address, interfaceHash)
            expect(interfaceHash).to.equal("0xb281fc8c12954d22544db45de3159a39272895b169a852b314f9cc762e44c53b");
            expect(implementer).to.equal(hoprFarm.address);
        })

        it('has hopr tokens on farm contract', async function () {
            expect((await hoprToken.balanceOf(hoprFarm.address)).toString()).to.equal(utils.parseEther("5000000").toString()); 
            claimBlocks = await Promise.all(period.map(async (c) => {
                const num = await hoprFarm.distributionBlocks(c);
                return parseInt(num);
            }));
            console.log(`Farm can be claimed at blocks: `)
            console.table(claimBlocks)
        })

        it('provides liquidity by other LPs', async function () {
            await provideLiquidity(provider1, "100");
            await provideLiquidity(provider2, "200");
            await provideLiquidity(provider3, "200");
        })

        it('stakes liquidity', async function () {
            await hoprFarm.connect(provider1).openFarm(utils.parseEther("100"));
            await hoprFarm.connect(provider2).openFarm(utils.parseEther("200"));
            expect((await uniPair.balanceOf(provider1Address)).toString()).to.equal(constants.Zero.toString()); 
            expect((await uniPair.balanceOf(provider2Address)).toString()).to.equal(constants.Zero.toString()); 
        })

        it('stakes liquidity with permit', async function () {
            expect((await uniPair.balanceOf(provider3Address)).toString()).to.equal(utils.parseEther("200").toString()); 
            const sig = await permitSignature(3, utils.parseEther("200"));
            await hoprFarm.connect(owner).openFarmWithPermit(utils.parseEther("200"), provider3Address, constants.MaxUint256, sig.v, sig.r, sig.s);
            expect((await uniPair.balanceOf(provider3Address)).toString()).to.equal(constants.Zero.toString()); 
        })

        it('is in period 0', async function () {
            expect((await hoprFarm.currentFarmPeriod()).toString()).to.equal(constants.Zero.toString()); 
        })
        
        it('provider 1/2/3 staked all their liquitidy tokens (100, 200, 200)', async function () {
            const FIVE_HUNDRED = utils.parseEther("500");
            expect((await hoprFarm.totalPoolBalance()).toString()).to.equal(FIVE_HUNDRED.toString()); 
            expect((await hoprFarm.eligibleLiquidityPerPeriod(1)).toString()).to.equal(FIVE_HUNDRED.toString()); 
        })
        
        it('has no incentive to be claimed', async function () {
            expect((await hoprFarm.incentiveToBeClaimed(provider1Address)).toString()).to.equal(constants.Zero.toString()); 
            expect((await hoprFarm.incentiveToBeClaimed(provider2Address)).toString()).to.equal(constants.Zero.toString()); 
            expect((await hoprFarm.incentiveToBeClaimed(provider3Address)).toString()).to.equal(constants.Zero.toString()); 
        })

        it('fails to claim', async function () {
            await expectRevert(hoprFarm.claimFor(provider1Address), "HoprFarm: Too early to claim")
        })

        it('needs 250 liquidity tokens to have a third of the current incentive', async function () {
            const virtualReturn = await hoprFarm.currentFarmIncentive(utils.parseEther("250"));
            const thirdOfCurrentIncentive = (await hoprFarm.WEEKLY_INCENTIVE()).div("3");
            expect(virtualReturn.toString()).to.equal(thirdOfCurrentIncentive.toString()); 
        })

        describe('Jump to period 1', function () {
            before(async function () {
                await advanceBlockTo(claimBlocks[0] + 10)
            })

            it('provides liquidity by other LPs', async function () {
                await provideLiquidity(provider1, "100");
                await provideLiquidity(provider2, "200");
                await hoprFarm.connect(provider1).openFarm(utils.parseEther("100"));
                await hoprFarm.connect(provider2).openFarm(utils.parseEther("200"));
            })

            it('Jumping to claimBlocks[1] ... ', async function () {
                await advanceBlockTo(5000)
            })
            it('Jumping to claimBlocks[1] ... ', async function () {
                await advanceBlockTo(10000)
            })
            it('Jumping to claimBlocks[1] ... ', async function () {
                await advanceBlockTo(15000)
            })
            it('Jumping to claimBlocks[1] ... ', async function () {
                await advanceBlockTo(20000)
            })
            it('Jumping to claimBlocks[1] ... ', async function () {
                await advanceBlockTo(25000)
            })
            it('Jumping to claimBlocks[1] ... ', async function () {
                await advanceBlockTo(30000)
            })
            it('Jumping to claimBlocks[1] ... ', async function () {
                await advanceBlockTo(35000)
            })
            it('Jumping to claimBlocks[1] ... ', async function () {
                await advanceBlockTo(40000)
            })
            it('Jumping to claimBlocks[1] ... ', async function () {
                await advanceBlockTo(45000)
            })

            it('Jumping to claimBlocks[1] ... ', async function () {
                await advanceBlockTo(claimBlocks[1] + 10)
            })

            it('has 1/5 to be claimed by provider 1', async function () {
                const fifthOfCurrentIncentive = (await hoprFarm.WEEKLY_INCENTIVE()).div("5");

                expect((await hoprFarm.incentiveToBeClaimed(provider1Address)).toString()).to.equal(fifthOfCurrentIncentive.toString()); 
            })

            it('claims (1/5 of the incentive from the 1st period) by provider 1. Its farm is still open', async function () {
                const beforeClaimHopr = await hoprToken.balanceOf(provider1Address);
                const beforeClaimPool = await uniPair.balanceOf(provider1Address);
                await hoprFarm.claimFor(provider1Address);
                const afterClaimHopr = await hoprToken.balanceOf(provider1Address);
                const afterClaimPool = await uniPair.balanceOf(provider1Address);

                const fifthOfCurrentIncentive = (await hoprFarm.WEEKLY_INCENTIVE()).div("5");

                expect(afterClaimHopr.sub(beforeClaimHopr).toString()).to.equal(fifthOfCurrentIncentive.toString()); 
                expect(beforeClaimPool).to.equal(constants.Zero.toString()); 
                expect(afterClaimPool).to.equal(constants.Zero.toString()); 
            })

            it('cannot claim again when incentives are claimed.', async function () {
                expectRevert(hoprFarm.connect(provider1).claimAndClose(), "HoprFarm: Nothing to claim");
            })

            it('cannot claim for a non LP', async function () {
                const randomHolder = (await ethers.getSigners())[5];
                const randomHolderAddress = await randomHolder.getAddress();
                // it emits an event with 0 token being transferred.
                expectRevert(hoprFarm.claimFor(randomHolderAddress), "HoprFarm: Nothing to claim");
            })
        })
        
        describe('Jump to period 3', function () {
            it('Jumping to claimBlocks[2] ... ', async function () {
                await advanceBlockTo(50000)
            })
            it('Jumping to claimBlocks[2] ... ', async function () {
                await advanceBlockTo(55000)
            })
            it('Jumping to claimBlocks[2] ... ', async function () {
                await advanceBlockTo(60000)
            })
            it('Jumping to claimBlocks[2] ... ', async function () {
                await advanceBlockTo(65000)
            })
            it('Jumping to claimBlocks[2] ... ', async function () {
                await advanceBlockTo(70000)
            })
            it('Jumping to claimBlocks[2] ... ', async function () {
                await advanceBlockTo(75000)
            })
            it('Jumping to claimBlocks[2] ... ', async function () {
                await advanceBlockTo(80000)
            })
            it('Jumping to claimBlocks[2] ... ', async function () {
                await advanceBlockTo(85000)
            })
            it('Jumping to claimBlocks[2] ... ', async function () {
                await advanceBlockTo(claimBlocks[2] + 10)
            })

            it('provider 1 claims again. Received 1/4 of period incentive (200/400/200)', async function () {
                const beforeClaimHopr = await hoprToken.balanceOf(provider1Address);
                const beforeClaimPool = await uniPair.balanceOf(provider1Address);
                await hoprFarm.claimFor(provider1Address);
                const afterClaimHopr = await hoprToken.balanceOf(provider1Address);
                const afterClaimPool = await uniPair.balanceOf(provider1Address);

                const fourthOfCurrentIncentive = (await hoprFarm.WEEKLY_INCENTIVE()).div("4");

                expect(afterClaimHopr.sub(beforeClaimHopr).toString()).to.equal(fourthOfCurrentIncentive.toString()); 
                expect(beforeClaimPool).to.equal(constants.Zero.toString()); 
                expect(afterClaimPool).to.equal(constants.Zero.toString()); 
            })

            it('provider 2 removes liquidity. Nothing claimed, just receives its pool token', async function () {
                const beforeClaimHopr = await hoprToken.balanceOf(provider2Address);
                const beforeClaimPool = await uniPair.balanceOf(provider2Address);
                await hoprFarm.connect(provider2).closeFarm(utils.parseEther("200"));
                const afterClaimHopr = await hoprToken.balanceOf(provider2Address);
                const afterClaimPool = await uniPair.balanceOf(provider2Address);

                expect(afterClaimPool.sub(beforeClaimPool).toString()).to.equal(utils.parseEther("200").toString()); 
                expect(afterClaimHopr.sub(beforeClaimHopr).toString()).to.equal(constants.Zero.toString()); 
            })

            it('provider 2 claims liquidity. Pool tokens remains but HOPR amount increases 2/5 + 1/2 = 0.9 of period incentive', async function () {
                // await advanceBlockTo(claimBlocks[2])
                const beforeClaimHopr = await hoprToken.balanceOf(provider2Address);
                const beforeClaimPool = await uniPair.balanceOf(provider2Address);
                await hoprFarm.claimFor(provider2Address);
                const afterClaimHopr = await hoprToken.balanceOf(provider2Address);
                const afterClaimPool = await uniPair.balanceOf(provider2Address);

                const incentive = (await hoprFarm.WEEKLY_INCENTIVE()).mul("9").div("10");

                expect(afterClaimPool.sub(beforeClaimPool).toString()).to.equal(constants.Zero.toString()); 
                expect(afterClaimHopr.sub(beforeClaimHopr).toString()).to.equal(incentive.toString()); 
            })

            it('cannot openFarm and claim in the same period. Owner provides 10 liquidity tokens', async function () {
                await hoprFarm.connect(owner).openFarm(utils.parseEther("10"));
                expect((await hoprFarm.incentiveToBeClaimed(ownerAddress)).toString()).to.equal(constants.Zero.toString()); 
                expectRevert(hoprFarm.claimFor(ownerAddress), "HoprFarm: Nothing to claim");
            })
        })
    })
  })
  