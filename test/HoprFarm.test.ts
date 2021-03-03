import * as factoryBuild from "@uniswap/v2-core/build/UniswapV2Factory.json";
import * as pairBuild from "@uniswap/v2-core/build/UniswapV2Pair.json";
import { ethers } from 'hardhat'
import { Contract, Signer, utils } from 'ethers'
import { getParamFromTxResponse } from '../utils/events';
import{ expect } from "chai";
import { it } from 'mocha';
import { deployRegistry } from "../utils/registry";
import { deployFromBytecode, deployContract, deployContract3 } from "../utils/contracts";
import { advanceBlockTo } from "../utils/time";

describe('HoprFarm', function () {
    let owner: Signer;
    let provider1: Signer;
    let provider2: Signer;
    let ownerAddress: string;
    let provider1Address: string;
    let provider2Address: string;
    let hoprToken: Contract
    let testDai: Contract
    let uniswapFactory: Contract;
    let uniPair: Contract;
    let hoprFarm: Contract;
    let erc1820: Contract;
  
    const period = Array.from(Array(14).keys());
    let claimBlocks;
  
    const reset = async () => {
        [owner, provider1, provider2] = await ethers.getSigners();
        ownerAddress = await owner.getAddress();
        provider1Address = await provider1.getAddress();
        provider2Address = await provider2.getAddress();

        uniswapFactory = await deployFromBytecode(owner, factoryBuild.abi, factoryBuild.bytecode, ownerAddress);

        // create and airdrop DAI
        testDai = await deployContract(owner, "TestDai", ownerAddress);
        await testDai.transfer(provider1Address, utils.parseEther("1000"));
        await testDai.transfer(provider2Address, utils.parseEther("2000"));

        // create and airdrop HOPR
        erc1820 = await deployRegistry(owner);
        hoprToken = await deployContract(owner, "HoprToken", null);
        await hoprToken.connect(owner).grantRole(await hoprToken.MINTER_ROLE(), ownerAddress)
        await hoprToken.mint(ownerAddress, utils.parseEther("5001000"), "0x", "0x");
        await hoprToken.mint(provider1Address, utils.parseEther("1000"), "0x", "0x");
        await hoprToken.mint(provider2Address, utils.parseEther("2000"), "0x", "0x");
        
        // owner create Uni pair
        const tx = await uniswapFactory.connect(owner).createPair(testDai.address, hoprToken.address);
        const receipt = await ethers.provider.waitForTransaction(tx.hash);
        const adr = await getParamFromTxResponse(receipt, "PairCreated(address,address,address,uint256)", 5, uniswapFactory.address.toLowerCase(), "Create uniswap pair");
        uniPair = new ethers.Contract("0x"+adr.slice(26,66), pairBuild.abi, ethers.provider)
        
        // create farm contract
        hoprFarm = await deployContract3(owner, "HoprFarm", uniPair.address, hoprToken.address, ownerAddress);
        // initialize contract by providing 5 m HOPR and the starting blocknumber, starting block is 256
        await hoprToken.connect(owner).send(hoprFarm.address, utils.parseEther("5000000"), "0x000100");

        // potential liquidity providers give allowance
        await uniPair.connect(owner).approve(hoprFarm.address, ethers.constants.MaxUint256);
        await uniPair.connect(provider1).approve(hoprFarm.address, ethers.constants.MaxUint256);
        await uniPair.connect(provider2).approve(hoprFarm.address, ethers.constants.MaxUint256);

        // -----logs
        console.log(`        | UniFactory | ${uniswapFactory.address} |`)
        console.log(`        | Hopr       | ${hoprToken.address} |`)
        console.log(`        | Dai        | ${testDai.address} |`)
        console.log(`        | UniPair    | ${uniPair.address} |`)
        console.log(`        | HoprFarm   | ${hoprFarm.address} |`)
    }

    const provideLiquidity = async (signer: Signer, amount: string) => {
        const signerAddress = await signer.getAddress();
        await hoprToken.connect(signer).transfer(uniPair.address, utils.parseEther(amount));
        await testDai.connect(signer).transfer(uniPair.address, utils.parseEther(amount));
        await uniPair.connect(owner).mint(signerAddress);
    }
  
    // reset contracts once
    describe('integration tests', function () {
        before(async function () {
            await reset()
        })
    
        it('provides the first liquidity from owner (100 HOPR and 100 DAI)', async function () {
            expect((await uniPair.balanceOf(ownerAddress)).toString()).to.equal(ethers.constants.Zero.toString()); 
            // add 100 HOPR and 100 Dai to the contract
            await provideLiquidity(owner, "100");
            const liquidity = await uniPair.balanceOf(ownerAddress);
            console.log("Liquidity", liquidity.toString());
        })

        it('can receive ERC777 on HoprFarm contract', async function () {
            const interfaceHash = utils.keccak256(utils.toUtf8Bytes('ERC777TokensRecipient'));
            const implementer = await erc1820.getInterfaceImplementer(hoprFarm.address, interfaceHash)
            expect(interfaceHash).to.equal("0xb281fc8c12954d22544db45de3159a39272895b169a852b314f9cc762e44c53b");
            expect(implementer).to.equal(hoprFarm.address);
        })

        it('has hopr tokens on farm contract', async function () {
            expect((await hoprToken.balanceOf(hoprFarm.address)).toString()).to.equal(utils.parseEther("5000000").toString()); 
            // const startBlock = await hoprFarm.distributionBlocks(0);
            const currentBlock = await ethers.provider.getBlockNumber();
            console.log(`Current block is ${currentBlock.toString()}`)
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
        })

        it('stakes liquidity', async function () {
            await hoprFarm.connect(provider1).openFarm(utils.parseEther("100"));
            await hoprFarm.connect(provider2).openFarm(utils.parseEther("200"));
            expect((await uniPair.balanceOf(provider1Address)).toString()).to.equal(ethers.constants.Zero.toString()); 
            expect((await uniPair.balanceOf(provider2Address)).toString()).to.equal(ethers.constants.Zero.toString()); 
        })

        it('owners stakes some tokens at period 0', async function () {
            const currentP = await hoprFarm.currentFarmPeriod();
            console.log(`current farm period is ${currentP.toString()}`)
            const liquidity = await uniPair.balanceOf(ownerAddress);
            const virtualReturn = await hoprFarm.currentFarmIncentive(liquidity);
            console.log(`Virtual return is ${virtualReturn.toString()}`)
        })

        describe('Jump to period 1', function () {
            before(async function () {
                await advanceBlockTo(claimBlocks[0])
            })

            it('increases block', async function () {
                const currentBlock = await ethers.provider.getBlockNumber();
                console.log(`Current block is ${currentBlock.toString()}`)
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

            it('jumps to period 2 and ask provider 1 to claim', async function () {
                await advanceBlockTo(claimBlocks[1])
                const beforeClaimHopr = await hoprToken.balanceOf(provider1Address);
                const beforeClaimPool = await uniPair.balanceOf(provider1Address);
                await hoprFarm.claimFor(provider1Address);
                const afterClaimHopr = await hoprToken.balanceOf(provider1Address);
                const afterClaimPool = await uniPair.balanceOf(provider1Address);
                console.log(`HOPR token from ${beforeClaimHopr.toString()} => ${afterClaimHopr.toString()}`)
                console.log(`Pool token from ${beforeClaimPool.toString()} => ${afterClaimPool.toString()}`)
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
                await advanceBlockTo(claimBlocks[2])
            })

            it('increases block', async function () {
                const currentBlock = await ethers.provider.getBlockNumber();
                console.log(`Current block is ${currentBlock.toString()}`)
            })

            it('provider 1 claims again', async function () {
                const beforeClaimHopr = await hoprToken.balanceOf(provider1Address);
                const beforeClaimPool = await uniPair.balanceOf(provider1Address);
                await hoprFarm.claimFor(provider1Address);
                const afterClaimHopr = await hoprToken.balanceOf(provider1Address);
                const afterClaimPool = await uniPair.balanceOf(provider1Address);
                console.log(`HOPR token from ${beforeClaimHopr.toString()} => ${afterClaimHopr.toString()}`)
                console.log(`Pool token from ${beforeClaimPool.toString()} => ${afterClaimPool.toString()}`)
            })

            it('provider 2 removes liquidity', async function () {
                const beforeClaimHopr = await hoprToken.balanceOf(provider2Address);
                const beforeClaimPool = await uniPair.balanceOf(provider2Address);
                await hoprFarm.connect(provider2).closeFarm(utils.parseEther("200"));
                const afterClaimHopr = await hoprToken.balanceOf(provider2Address);
                const afterClaimPool = await uniPair.balanceOf(provider2Address);
                console.log(`HOPR token from ${beforeClaimHopr.toString()} => ${afterClaimHopr.toString()}`)
                console.log(`Pool token from ${beforeClaimPool.toString()} => ${afterClaimPool.toString()}`)
            })

            it('provider 2 claims liquidity', async function () {
                // await advanceBlockTo(claimBlocks[2])
                const beforeClaimHopr = await hoprToken.balanceOf(provider2Address);
                const beforeClaimPool = await uniPair.balanceOf(provider2Address);
                await hoprFarm.claimFor(provider2Address);
                const afterClaimHopr = await hoprToken.balanceOf(provider2Address);
                const afterClaimPool = await uniPair.balanceOf(provider2Address);
                console.log(`HOPR token from ${beforeClaimHopr.toString()} => ${afterClaimHopr.toString()}`)
                console.log(`Pool token from ${beforeClaimPool.toString()} => ${afterClaimPool.toString()}`)
            })
        })
    })
  })
  