const { expect, use } = require("chai")
const { solidity } = require("ethereum-waffle")
const { deployContract } = require("../shared/fixtures")
const { expandDecimals, getBlockTime, increaseTime, mineBlock, reportGasUsed, print, newWallet } = require("../shared/utilities")
const { toChainlinkPrice } = require("../shared/chainlink")
const { toUsd, toNormalizedPrice } = require("../shared/units")
const { initVault, getBnbConfig, getBtcConfig, getDaiConfig } = require("../core/Vault/helpers")

use(solidity)

describe("RewardRouterV2", function () {
  const provider = waffle.provider
  const [wallet, user0, user1, user2, user3, tokenManager] = provider.getWallets()

  const vestingDuration = 365 * 24 * 60 * 60

  let timelock
  let rewardManager

  let vault
  let glpManager
  let glp
  let usdg
  let router
  let vaultPriceFeed
  let bnb
  let bnbPriceFeed
  let btc
  let btcPriceFeed
  let eth
  let ethPriceFeed
  let dai
  let daiPriceFeed
  let busd
  let busdPriceFeed

  let gmx
  let esGmx
  let bnGmx

  let stakedGmxTracker
  let stakedGmxDistributor
  let bonusGmxTracker
  let bonusGmxDistributor
  let feeGmxTracker
  let feeGmxDistributor

  let feeGlpTracker
  let feeGlpDistributor
  let stakedGlpTracker
  let stakedGlpDistributor

  let gmxVester
  let glpVester

  let rewardRouter

  beforeEach(async () => {
    rewardManager = await deployContract("RewardManager", [])
    timelock = await deployContract("Timelock", [
      wallet.address,
      10,
      rewardManager.address,
      tokenManager.address,
      tokenManager.address,
      expandDecimals(1000000, 18)
    ])

    bnb = await deployContract("Token", [])
    bnbPriceFeed = await deployContract("PriceFeed", [])

    btc = await deployContract("Token", [])
    btcPriceFeed = await deployContract("PriceFeed", [])

    eth = await deployContract("Token", [])
    ethPriceFeed = await deployContract("PriceFeed", [])

    dai = await deployContract("Token", [])
    daiPriceFeed = await deployContract("PriceFeed", [])

    busd = await deployContract("Token", [])
    busdPriceFeed = await deployContract("PriceFeed", [])

    vault = await deployContract("Vault", [])
    usdg = await deployContract("USDG", [vault.address])
    router = await deployContract("Router", [vault.address, usdg.address, bnb.address])
    vaultPriceFeed = await deployContract("VaultPriceFeed", [])
    glp = await deployContract("GLP", [])

    await initVault(vault, router, usdg, vaultPriceFeed)
    glpManager = await deployContract("GlpManager", [vault.address, usdg.address, glp.address, 24 * 60 * 60])

    await vaultPriceFeed.setTokenConfig(bnb.address, bnbPriceFeed.address, 8, false)
    await vaultPriceFeed.setTokenConfig(btc.address, btcPriceFeed.address, 8, false)
    await vaultPriceFeed.setTokenConfig(eth.address, ethPriceFeed.address, 8, false)
    await vaultPriceFeed.setTokenConfig(dai.address, daiPriceFeed.address, 8, false)

    await daiPriceFeed.setLatestAnswer(toChainlinkPrice(1))
    await vault.setTokenConfig(...getDaiConfig(dai, daiPriceFeed))

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(60000))
    await vault.setTokenConfig(...getBtcConfig(btc, btcPriceFeed))

    await bnbPriceFeed.setLatestAnswer(toChainlinkPrice(300))
    await vault.setTokenConfig(...getBnbConfig(bnb, bnbPriceFeed))

    await glp.setInPrivateTransferMode(true)
    await glp.setMinter(glpManager.address, true)
    await glpManager.setInPrivateMode(true)

    gmx = await deployContract("GMX", []);
    esGmx = await deployContract("EsGMX", []);
    bnGmx = await deployContract("MintableBaseToken", ["Bonus GMX", "bnGMX", 0]);

    // GMX
    stakedGmxTracker = await deployContract("RewardTracker", ["Staked GMX", "sGMX"])
    stakedGmxDistributor = await deployContract("RewardDistributor", [esGmx.address, stakedGmxTracker.address])
    await stakedGmxTracker.initialize([gmx.address, esGmx.address], stakedGmxDistributor.address)
    await stakedGmxDistributor.updateLastDistributionTime()

    bonusGmxTracker = await deployContract("RewardTracker", ["Staked + Bonus GMX", "sbGMX"])
    bonusGmxDistributor = await deployContract("BonusDistributor", [bnGmx.address, bonusGmxTracker.address])
    await bonusGmxTracker.initialize([stakedGmxTracker.address], bonusGmxDistributor.address)
    await bonusGmxDistributor.updateLastDistributionTime()

    feeGmxTracker = await deployContract("RewardTracker", ["Staked + Bonus + Fee GMX", "sbfGMX"])
    feeGmxDistributor = await deployContract("RewardDistributor", [eth.address, feeGmxTracker.address])
    await feeGmxTracker.initialize([bonusGmxTracker.address, bnGmx.address], feeGmxDistributor.address)
    await feeGmxDistributor.updateLastDistributionTime()

    // GLP
    feeGlpTracker = await deployContract("RewardTracker", ["Fee GLP", "fGLP"])
    feeGlpDistributor = await deployContract("RewardDistributor", [eth.address, feeGlpTracker.address])
    await feeGlpTracker.initialize([glp.address], feeGlpDistributor.address)
    await feeGlpDistributor.updateLastDistributionTime()

    stakedGlpTracker = await deployContract("RewardTracker", ["Fee + Staked GLP", "fsGLP"])
    stakedGlpDistributor = await deployContract("RewardDistributor", [esGmx.address, stakedGlpTracker.address])
    await stakedGlpTracker.initialize([feeGlpTracker.address], stakedGlpDistributor.address)
    await stakedGlpDistributor.updateLastDistributionTime()

    gmxVester = await deployContract("Vester", [
      "Vested GMX", // _name
      "vGMX", // _symbol
      vestingDuration, // _vestingDuration
      esGmx.address, // _esToken
      feeGmxTracker.address, // _pairToken
      gmx.address, // _claimableToken
      stakedGmxTracker.address, // _rewardTracker
    ])

    glpVester = await deployContract("Vester", [
      "Vested GLP", // _name
      "vGLP", // _symbol
      vestingDuration, // _vestingDuration
      esGmx.address, // _esToken
      stakedGlpTracker.address, // _pairToken
      gmx.address, // _claimableToken
      stakedGlpTracker.address, // _rewardTracker
    ])

    await stakedGmxTracker.setInPrivateTransferMode(true)
    await stakedGmxTracker.setInPrivateStakingMode(true)
    await bonusGmxTracker.setInPrivateTransferMode(true)
    await bonusGmxTracker.setInPrivateStakingMode(true)
    await bonusGmxTracker.setInPrivateClaimingMode(true)
    await feeGmxTracker.setInPrivateTransferMode(true)
    await feeGmxTracker.setInPrivateStakingMode(true)

    await feeGlpTracker.setInPrivateTransferMode(true)
    await feeGlpTracker.setInPrivateStakingMode(true)
    await stakedGlpTracker.setInPrivateTransferMode(true)
    await stakedGlpTracker.setInPrivateStakingMode(true)

    await esGmx.setInPrivateTransferMode(true)

    rewardRouter = await deployContract("RewardRouterV2", [])
    await rewardRouter.initialize(
      bnb.address,
      gmx.address,
      esGmx.address,
      bnGmx.address,
      glp.address,
      stakedGmxTracker.address,
      bonusGmxTracker.address,
      feeGmxTracker.address,
      feeGlpTracker.address,
      stakedGlpTracker.address,
      glpManager.address,
      gmxVester.address,
      glpVester.address
    )

    await rewardManager.initialize(
      timelock.address,
      rewardRouter.address,
      glpManager.address,
      stakedGmxTracker.address,
      bonusGmxTracker.address,
      feeGmxTracker.address,
      feeGlpTracker.address,
      stakedGlpTracker.address,
      stakedGmxDistributor.address,
      stakedGlpDistributor.address,
      esGmx.address,
      bnGmx.address,
      gmxVester.address,
      glpVester.address
    )

    // allow bonusGmxTracker to stake stakedGmxTracker
    await stakedGmxTracker.setHandler(bonusGmxTracker.address, true)
    // allow bonusGmxTracker to stake feeGmxTracker
    await bonusGmxTracker.setHandler(feeGmxTracker.address, true)
    await bonusGmxDistributor.setBonusMultiplier(10000)
    // allow feeGmxTracker to stake bnGmx
    await bnGmx.setHandler(feeGmxTracker.address, true)

    // allow stakedGlpTracker to stake feeGlpTracker
    await feeGlpTracker.setHandler(stakedGlpTracker.address, true)
    // allow feeGlpTracker to stake glp
    await glp.setHandler(feeGlpTracker.address, true)

    // mint esGmx for distributors
    await esGmx.setMinter(wallet.address, true)
    await esGmx.mint(stakedGmxDistributor.address, expandDecimals(50000, 18))
    await stakedGmxDistributor.setTokensPerInterval("20667989410000000") // 0.02066798941 esGmx per second
    await esGmx.mint(stakedGlpDistributor.address, expandDecimals(50000, 18))
    await stakedGlpDistributor.setTokensPerInterval("20667989410000000") // 0.02066798941 esGmx per second

    // mint bnGmx for distributor
    await bnGmx.setMinter(wallet.address, true)
    await bnGmx.mint(bonusGmxDistributor.address, expandDecimals(1500, 18))

    await esGmx.setHandler(tokenManager.address, true)
    await gmxVester.setHandler(wallet.address, true)

    await glpManager.setGov(timelock.address)
    await stakedGmxTracker.setGov(timelock.address)
    await bonusGmxTracker.setGov(timelock.address)
    await feeGmxTracker.setGov(timelock.address)
    await feeGlpTracker.setGov(timelock.address)
    await stakedGlpTracker.setGov(timelock.address)
    await stakedGmxDistributor.setGov(timelock.address)
    await stakedGlpDistributor.setGov(timelock.address)
    await esGmx.setGov(timelock.address)
    await bnGmx.setGov(timelock.address)
    await gmxVester.setGov(timelock.address)
    await glpVester.setGov(timelock.address)

    await rewardManager.updateEsGmxHandlers()
    await rewardManager.enableRewardRouter()
  })

  it("inits", async () => {
    expect(await rewardRouter.isInitialized()).eq(true)

    expect(await rewardRouter.weth()).eq(bnb.address)
    expect(await rewardRouter.gmx()).eq(gmx.address)
    expect(await rewardRouter.esGmx()).eq(esGmx.address)
    expect(await rewardRouter.bnGmx()).eq(bnGmx.address)

    expect(await rewardRouter.glp()).eq(glp.address)

    expect(await rewardRouter.stakedGmxTracker()).eq(stakedGmxTracker.address)
    expect(await rewardRouter.bonusGmxTracker()).eq(bonusGmxTracker.address)
    expect(await rewardRouter.feeGmxTracker()).eq(feeGmxTracker.address)

    expect(await rewardRouter.feeGlpTracker()).eq(feeGlpTracker.address)
    expect(await rewardRouter.stakedGlpTracker()).eq(stakedGlpTracker.address)

    expect(await rewardRouter.glpManager()).eq(glpManager.address)

    expect(await rewardRouter.gmxVester()).eq(gmxVester.address)
    expect(await rewardRouter.glpVester()).eq(glpVester.address)

    await expect(rewardRouter.initialize(
      bnb.address,
      gmx.address,
      esGmx.address,
      bnGmx.address,
      glp.address,
      stakedGmxTracker.address,
      bonusGmxTracker.address,
      feeGmxTracker.address,
      feeGlpTracker.address,
      stakedGlpTracker.address,
      glpManager.address,
      gmxVester.address,
      glpVester.address
    )).to.be.revertedWith("RewardRouter: already initialized")

    expect(await rewardManager.timelock()).eq(timelock.address)
    expect(await rewardManager.rewardRouter()).eq(rewardRouter.address)
    expect(await rewardManager.glpManager()).eq(glpManager.address)
    expect(await rewardManager.stakedGmxTracker()).eq(stakedGmxTracker.address)
    expect(await rewardManager.bonusGmxTracker()).eq(bonusGmxTracker.address)
    expect(await rewardManager.feeGmxTracker()).eq(feeGmxTracker.address)
    expect(await rewardManager.feeGlpTracker()).eq(feeGlpTracker.address)
    expect(await rewardManager.stakedGlpTracker()).eq(stakedGlpTracker.address)
    expect(await rewardManager.stakedGmxTracker()).eq(stakedGmxTracker.address)
    expect(await rewardManager.stakedGmxDistributor()).eq(stakedGmxDistributor.address)
    expect(await rewardManager.stakedGlpDistributor()).eq(stakedGlpDistributor.address)
    expect(await rewardManager.esGmx()).eq(esGmx.address)
    expect(await rewardManager.bnGmx()).eq(bnGmx.address)
    expect(await rewardManager.gmxVester()).eq(gmxVester.address)
    expect(await rewardManager.glpVester()).eq(glpVester.address)

    await expect(rewardManager.initialize(
      timelock.address,
      rewardRouter.address,
      glpManager.address,
      stakedGmxTracker.address,
      bonusGmxTracker.address,
      feeGmxTracker.address,
      feeGlpTracker.address,
      stakedGlpTracker.address,
      stakedGmxDistributor.address,
      stakedGlpDistributor.address,
      esGmx.address,
      bnGmx.address,
      gmxVester.address,
      glpVester.address
    )).to.be.revertedWith("RewardManager: already initialized")
  })

  it("stakeGmxForAccount, stakeGmx, stakeEsGmx, unstakeGmx, unstakeEsGmx, claimEsGmx, claimFees, compound, batchCompoundForAccounts", async () => {
    await eth.mint(feeGmxDistributor.address, expandDecimals(100, 18))
    await feeGmxDistributor.setTokensPerInterval("41335970000000") // 0.00004133597 ETH per second

    await gmx.setMinter(wallet.address, true)
    await gmx.mint(user0.address, expandDecimals(1500, 18))
    expect(await gmx.balanceOf(user0.address)).eq(expandDecimals(1500, 18))

    await gmx.connect(user0).approve(stakedGmxTracker.address, expandDecimals(1000, 18))
    await expect(rewardRouter.connect(user0).stakeGmxForAccount(user1.address, expandDecimals(1000, 18)))
      .to.be.revertedWith("Governable: forbidden")

    await rewardRouter.setGov(user0.address)
    await rewardRouter.connect(user0).stakeGmxForAccount(user1.address, expandDecimals(800, 18))
    expect(await gmx.balanceOf(user0.address)).eq(expandDecimals(700, 18))

    await gmx.mint(user1.address, expandDecimals(200, 18))
    expect(await gmx.balanceOf(user1.address)).eq(expandDecimals(200, 18))
    await gmx.connect(user1).approve(stakedGmxTracker.address, expandDecimals(200, 18))
    await rewardRouter.connect(user1).stakeGmx(expandDecimals(200, 18))
    expect(await gmx.balanceOf(user1.address)).eq(0)

    expect(await stakedGmxTracker.stakedAmounts(user0.address)).eq(0)
    expect(await stakedGmxTracker.depositBalances(user0.address, gmx.address)).eq(0)
    expect(await stakedGmxTracker.stakedAmounts(user1.address)).eq(expandDecimals(1000, 18))
    expect(await stakedGmxTracker.depositBalances(user1.address, gmx.address)).eq(expandDecimals(1000, 18))

    expect(await bonusGmxTracker.stakedAmounts(user0.address)).eq(0)
    expect(await bonusGmxTracker.depositBalances(user0.address, stakedGmxTracker.address)).eq(0)
    expect(await bonusGmxTracker.stakedAmounts(user1.address)).eq(expandDecimals(1000, 18))
    expect(await bonusGmxTracker.depositBalances(user1.address, stakedGmxTracker.address)).eq(expandDecimals(1000, 18))

    expect(await feeGmxTracker.stakedAmounts(user0.address)).eq(0)
    expect(await feeGmxTracker.depositBalances(user0.address, bonusGmxTracker.address)).eq(0)
    expect(await feeGmxTracker.stakedAmounts(user1.address)).eq(expandDecimals(1000, 18))
    expect(await feeGmxTracker.depositBalances(user1.address, bonusGmxTracker.address)).eq(expandDecimals(1000, 18))

    await increaseTime(provider, 24 * 60 * 60)
    await mineBlock(provider)

    expect(await stakedGmxTracker.claimable(user0.address)).eq(0)
    expect(await stakedGmxTracker.claimable(user1.address)).gt(expandDecimals(1785, 18)) // 50000 / 28 => ~1785
    expect(await stakedGmxTracker.claimable(user1.address)).lt(expandDecimals(1786, 18))

    expect(await bonusGmxTracker.claimable(user0.address)).eq(0)
    expect(await bonusGmxTracker.claimable(user1.address)).gt("2730000000000000000") // 2.73, 1000 / 365 => ~2.74
    expect(await bonusGmxTracker.claimable(user1.address)).lt("2750000000000000000") // 2.75

    expect(await feeGmxTracker.claimable(user0.address)).eq(0)
    expect(await feeGmxTracker.claimable(user1.address)).gt("3560000000000000000") // 3.56, 100 / 28 => ~3.57
    expect(await feeGmxTracker.claimable(user1.address)).lt("3580000000000000000") // 3.58

    await timelock.mint(esGmx.address, expandDecimals(500, 18))
    await esGmx.connect(tokenManager).transferFrom(tokenManager.address, user2.address, expandDecimals(500, 18))
    await rewardRouter.connect(user2).stakeEsGmx(expandDecimals(500, 18))

    expect(await stakedGmxTracker.stakedAmounts(user0.address)).eq(0)
    expect(await stakedGmxTracker.depositBalances(user0.address, gmx.address)).eq(0)
    expect(await stakedGmxTracker.stakedAmounts(user1.address)).eq(expandDecimals(1000, 18))
    expect(await stakedGmxTracker.depositBalances(user1.address, gmx.address)).eq(expandDecimals(1000, 18))
    expect(await stakedGmxTracker.stakedAmounts(user2.address)).eq(expandDecimals(500, 18))
    expect(await stakedGmxTracker.depositBalances(user2.address, esGmx.address)).eq(expandDecimals(500, 18))

    expect(await bonusGmxTracker.stakedAmounts(user0.address)).eq(0)
    expect(await bonusGmxTracker.depositBalances(user0.address, stakedGmxTracker.address)).eq(0)
    expect(await bonusGmxTracker.stakedAmounts(user1.address)).eq(expandDecimals(1000, 18))
    expect(await bonusGmxTracker.depositBalances(user1.address, stakedGmxTracker.address)).eq(expandDecimals(1000, 18))
    expect(await bonusGmxTracker.stakedAmounts(user2.address)).eq(expandDecimals(500, 18))
    expect(await bonusGmxTracker.depositBalances(user2.address, stakedGmxTracker.address)).eq(expandDecimals(500, 18))

    expect(await feeGmxTracker.stakedAmounts(user0.address)).eq(0)
    expect(await feeGmxTracker.depositBalances(user0.address, bonusGmxTracker.address)).eq(0)
    expect(await feeGmxTracker.stakedAmounts(user1.address)).eq(expandDecimals(1000, 18))
    expect(await feeGmxTracker.depositBalances(user1.address, bonusGmxTracker.address)).eq(expandDecimals(1000, 18))
    expect(await feeGmxTracker.stakedAmounts(user2.address)).eq(expandDecimals(500, 18))
    expect(await feeGmxTracker.depositBalances(user2.address, bonusGmxTracker.address)).eq(expandDecimals(500, 18))

    await increaseTime(provider, 24 * 60 * 60)
    await mineBlock(provider)

    expect(await stakedGmxTracker.claimable(user0.address)).eq(0)
    expect(await stakedGmxTracker.claimable(user1.address)).gt(expandDecimals(1785 + 1190, 18))
    expect(await stakedGmxTracker.claimable(user1.address)).lt(expandDecimals(1786 + 1191, 18))
    expect(await stakedGmxTracker.claimable(user2.address)).gt(expandDecimals(595, 18))
    expect(await stakedGmxTracker.claimable(user2.address)).lt(expandDecimals(596, 18))

    expect(await bonusGmxTracker.claimable(user0.address)).eq(0)
    expect(await bonusGmxTracker.claimable(user1.address)).gt("5470000000000000000") // 5.47, 1000 / 365 * 2 => ~5.48
    expect(await bonusGmxTracker.claimable(user1.address)).lt("5490000000000000000")
    expect(await bonusGmxTracker.claimable(user2.address)).gt("1360000000000000000") // 1.36, 500 / 365 => ~1.37
    expect(await bonusGmxTracker.claimable(user2.address)).lt("1380000000000000000")

    expect(await feeGmxTracker.claimable(user0.address)).eq(0)
    expect(await feeGmxTracker.claimable(user1.address)).gt("5940000000000000000") // 5.94, 3.57 + 100 / 28 / 3 * 2 => ~5.95
    expect(await feeGmxTracker.claimable(user1.address)).lt("5960000000000000000")
    expect(await feeGmxTracker.claimable(user2.address)).gt("1180000000000000000") // 1.18, 100 / 28 / 3 => ~1.19
    expect(await feeGmxTracker.claimable(user2.address)).lt("1200000000000000000")

    expect(await esGmx.balanceOf(user1.address)).eq(0)
    await rewardRouter.connect(user1).claimEsGmx()
    expect(await esGmx.balanceOf(user1.address)).gt(expandDecimals(1785 + 1190, 18))
    expect(await esGmx.balanceOf(user1.address)).lt(expandDecimals(1786 + 1191, 18))

    expect(await eth.balanceOf(user1.address)).eq(0)
    await rewardRouter.connect(user1).claimFees()
    expect(await eth.balanceOf(user1.address)).gt("5940000000000000000")
    expect(await eth.balanceOf(user1.address)).lt("5960000000000000000")

    expect(await esGmx.balanceOf(user2.address)).eq(0)
    await rewardRouter.connect(user2).claimEsGmx()
    expect(await esGmx.balanceOf(user2.address)).gt(expandDecimals(595, 18))
    expect(await esGmx.balanceOf(user2.address)).lt(expandDecimals(596, 18))

    expect(await eth.balanceOf(user2.address)).eq(0)
    await rewardRouter.connect(user2).claimFees()
    expect(await eth.balanceOf(user2.address)).gt("1180000000000000000")
    expect(await eth.balanceOf(user2.address)).lt("1200000000000000000")

    await increaseTime(provider, 24 * 60 * 60)
    await mineBlock(provider)

    const tx0 = await rewardRouter.connect(user1).compound()
    await reportGasUsed(provider, tx0, "compound gas used")

    await increaseTime(provider, 24 * 60 * 60)
    await mineBlock(provider)

    const tx1 = await rewardRouter.connect(user0).batchCompoundForAccounts([user1.address, user2.address])
    await reportGasUsed(provider, tx1, "batchCompoundForAccounts gas used")

    expect(await stakedGmxTracker.stakedAmounts(user1.address)).gt(expandDecimals(3643, 18))
    expect(await stakedGmxTracker.stakedAmounts(user1.address)).lt(expandDecimals(3645, 18))
    expect(await stakedGmxTracker.depositBalances(user1.address, gmx.address)).eq(expandDecimals(1000, 18))
    expect(await stakedGmxTracker.depositBalances(user1.address, esGmx.address)).gt(expandDecimals(2643, 18))
    expect(await stakedGmxTracker.depositBalances(user1.address, esGmx.address)).lt(expandDecimals(2645, 18))

    expect(await bonusGmxTracker.stakedAmounts(user1.address)).gt(expandDecimals(3643, 18))
    expect(await bonusGmxTracker.stakedAmounts(user1.address)).lt(expandDecimals(3645, 18))

    expect(await feeGmxTracker.stakedAmounts(user1.address)).gt(expandDecimals(3657, 18))
    expect(await feeGmxTracker.stakedAmounts(user1.address)).lt(expandDecimals(3659, 18))
    expect(await feeGmxTracker.depositBalances(user1.address, bonusGmxTracker.address)).gt(expandDecimals(3643, 18))
    expect(await feeGmxTracker.depositBalances(user1.address, bonusGmxTracker.address)).lt(expandDecimals(3645, 18))
    expect(await feeGmxTracker.depositBalances(user1.address, bnGmx.address)).gt("14100000000000000000") // 14.1
    expect(await feeGmxTracker.depositBalances(user1.address, bnGmx.address)).lt("14300000000000000000") // 14.3

    expect(await gmx.balanceOf(user1.address)).eq(0)
    await rewardRouter.connect(user1).unstakeGmx(expandDecimals(300, 18))
    expect(await gmx.balanceOf(user1.address)).eq(expandDecimals(300, 18))

    expect(await stakedGmxTracker.stakedAmounts(user1.address)).gt(expandDecimals(3343, 18))
    expect(await stakedGmxTracker.stakedAmounts(user1.address)).lt(expandDecimals(3345, 18))
    expect(await stakedGmxTracker.depositBalances(user1.address, gmx.address)).eq(expandDecimals(700, 18))
    expect(await stakedGmxTracker.depositBalances(user1.address, esGmx.address)).gt(expandDecimals(2643, 18))
    expect(await stakedGmxTracker.depositBalances(user1.address, esGmx.address)).lt(expandDecimals(2645, 18))

    expect(await bonusGmxTracker.stakedAmounts(user1.address)).gt(expandDecimals(3343, 18))
    expect(await bonusGmxTracker.stakedAmounts(user1.address)).lt(expandDecimals(3345, 18))

    expect(await feeGmxTracker.stakedAmounts(user1.address)).gt(expandDecimals(3357, 18))
    expect(await feeGmxTracker.stakedAmounts(user1.address)).lt(expandDecimals(3359, 18))
    expect(await feeGmxTracker.depositBalances(user1.address, bonusGmxTracker.address)).gt(expandDecimals(3343, 18))
    expect(await feeGmxTracker.depositBalances(user1.address, bonusGmxTracker.address)).lt(expandDecimals(3345, 18))
    expect(await feeGmxTracker.depositBalances(user1.address, bnGmx.address)).gt("13000000000000000000") // 13
    expect(await feeGmxTracker.depositBalances(user1.address, bnGmx.address)).lt("13100000000000000000") // 13.1

    const esGmxBalance1 = await esGmx.balanceOf(user1.address)
    const esGmxUnstakeBalance1 = await stakedGmxTracker.depositBalances(user1.address, esGmx.address)
    await rewardRouter.connect(user1).unstakeEsGmx(esGmxUnstakeBalance1)
    expect(await esGmx.balanceOf(user1.address)).eq(esGmxBalance1.add(esGmxUnstakeBalance1))

    expect(await stakedGmxTracker.stakedAmounts(user1.address)).eq(expandDecimals(700, 18))
    expect(await stakedGmxTracker.depositBalances(user1.address, gmx.address)).eq(expandDecimals(700, 18))
    expect(await stakedGmxTracker.depositBalances(user1.address, esGmx.address)).eq(0)

    expect(await bonusGmxTracker.stakedAmounts(user1.address)).eq(expandDecimals(700, 18))

    expect(await feeGmxTracker.stakedAmounts(user1.address)).gt(expandDecimals(702, 18))
    expect(await feeGmxTracker.stakedAmounts(user1.address)).lt(expandDecimals(703, 18))
    expect(await feeGmxTracker.depositBalances(user1.address, bonusGmxTracker.address)).eq(expandDecimals(700, 18))
    expect(await feeGmxTracker.depositBalances(user1.address, bnGmx.address)).gt("2720000000000000000") // 2.72
    expect(await feeGmxTracker.depositBalances(user1.address, bnGmx.address)).lt("2740000000000000000") // 2.74

    await expect(rewardRouter.connect(user1).unstakeEsGmx(expandDecimals(1, 18)))
      .to.be.revertedWith("RewardTracker: _amount exceeds depositBalance")
  })

  it("mintAndStakeGlp, unstakeAndRedeemGlp, compound, batchCompoundForAccounts", async () => {
    await eth.mint(feeGlpDistributor.address, expandDecimals(100, 18))
    await feeGlpDistributor.setTokensPerInterval("41335970000000") // 0.00004133597 ETH per second

    await bnb.mint(user1.address, expandDecimals(1, 18))
    await bnb.connect(user1).approve(glpManager.address, expandDecimals(1, 18))
    const tx0 = await rewardRouter.connect(user1).mintAndStakeGlp(
      bnb.address,
      expandDecimals(1, 18),
      expandDecimals(299, 18),
      expandDecimals(299, 18)
    )
    await reportGasUsed(provider, tx0, "mintAndStakeGlp gas used")

    expect(await feeGlpTracker.stakedAmounts(user1.address)).eq(expandDecimals(2991, 17))
    expect(await feeGlpTracker.depositBalances(user1.address, glp.address)).eq(expandDecimals(2991, 17))

    expect(await stakedGlpTracker.stakedAmounts(user1.address)).eq(expandDecimals(2991, 17))
    expect(await stakedGlpTracker.depositBalances(user1.address, feeGlpTracker.address)).eq(expandDecimals(2991, 17))

    await bnb.mint(user1.address, expandDecimals(2, 18))
    await bnb.connect(user1).approve(glpManager.address, expandDecimals(2, 18))
    await rewardRouter.connect(user1).mintAndStakeGlp(
      bnb.address,
      expandDecimals(2, 18),
      expandDecimals(299, 18),
      expandDecimals(299, 18)
    )

    await increaseTime(provider, 24 * 60 * 60 + 1)
    await mineBlock(provider)

    expect(await feeGlpTracker.claimable(user1.address)).gt("3560000000000000000") // 3.56, 100 / 28 => ~3.57
    expect(await feeGlpTracker.claimable(user1.address)).lt("3580000000000000000") // 3.58

    expect(await stakedGlpTracker.claimable(user1.address)).gt(expandDecimals(1785, 18)) // 50000 / 28 => ~1785
    expect(await stakedGlpTracker.claimable(user1.address)).lt(expandDecimals(1786, 18))

    await bnb.mint(user2.address, expandDecimals(1, 18))
    await bnb.connect(user2).approve(glpManager.address, expandDecimals(1, 18))
    await rewardRouter.connect(user2).mintAndStakeGlp(
      bnb.address,
      expandDecimals(1, 18),
      expandDecimals(299, 18),
      expandDecimals(299, 18)
    )

    await expect(rewardRouter.connect(user2).unstakeAndRedeemGlp(
      bnb.address,
      expandDecimals(299, 18),
      "990000000000000000", // 0.99
      user2.address
    )).to.be.revertedWith("GlpManager: cooldown duration not yet passed")

    expect(await feeGlpTracker.stakedAmounts(user1.address)).eq("897300000000000000000") // 897.3
    expect(await stakedGlpTracker.stakedAmounts(user1.address)).eq("897300000000000000000")
    expect(await bnb.balanceOf(user1.address)).eq(0)

    const tx1 = await rewardRouter.connect(user1).unstakeAndRedeemGlp(
      bnb.address,
      expandDecimals(299, 18),
      "990000000000000000", // 0.99
      user1.address
    )
    await reportGasUsed(provider, tx1, "unstakeAndRedeemGlp gas used")

    expect(await feeGlpTracker.stakedAmounts(user1.address)).eq("598300000000000000000") // 598.3
    expect(await stakedGlpTracker.stakedAmounts(user1.address)).eq("598300000000000000000")
    expect(await bnb.balanceOf(user1.address)).eq("993676666666666666") // ~0.99

    await increaseTime(provider, 24 * 60 * 60)
    await mineBlock(provider)

    expect(await feeGlpTracker.claimable(user1.address)).gt("5940000000000000000") // 5.94, 3.57 + 100 / 28 / 3 * 2 => ~5.95
    expect(await feeGlpTracker.claimable(user1.address)).lt("5960000000000000000")
    expect(await feeGlpTracker.claimable(user2.address)).gt("1180000000000000000") // 1.18, 100 / 28 / 3 => ~1.19
    expect(await feeGlpTracker.claimable(user2.address)).lt("1200000000000000000")

    expect(await stakedGlpTracker.claimable(user1.address)).gt(expandDecimals(1785 + 1190, 18))
    expect(await stakedGlpTracker.claimable(user1.address)).lt(expandDecimals(1786 + 1191, 18))
    expect(await stakedGlpTracker.claimable(user2.address)).gt(expandDecimals(595, 18))
    expect(await stakedGlpTracker.claimable(user2.address)).lt(expandDecimals(596, 18))

    expect(await esGmx.balanceOf(user1.address)).eq(0)
    await rewardRouter.connect(user1).claimEsGmx()
    expect(await esGmx.balanceOf(user1.address)).gt(expandDecimals(1785 + 1190, 18))
    expect(await esGmx.balanceOf(user1.address)).lt(expandDecimals(1786 + 1191, 18))

    expect(await eth.balanceOf(user1.address)).eq(0)
    await rewardRouter.connect(user1).claimFees()
    expect(await eth.balanceOf(user1.address)).gt("5940000000000000000")
    expect(await eth.balanceOf(user1.address)).lt("5960000000000000000")

    expect(await esGmx.balanceOf(user2.address)).eq(0)
    await rewardRouter.connect(user2).claimEsGmx()
    expect(await esGmx.balanceOf(user2.address)).gt(expandDecimals(595, 18))
    expect(await esGmx.balanceOf(user2.address)).lt(expandDecimals(596, 18))

    expect(await eth.balanceOf(user2.address)).eq(0)
    await rewardRouter.connect(user2).claimFees()
    expect(await eth.balanceOf(user2.address)).gt("1180000000000000000")
    expect(await eth.balanceOf(user2.address)).lt("1200000000000000000")

    await increaseTime(provider, 24 * 60 * 60)
    await mineBlock(provider)

    const tx2 = await rewardRouter.connect(user1).compound()
    await reportGasUsed(provider, tx2, "compound gas used")

    await increaseTime(provider, 24 * 60 * 60)
    await mineBlock(provider)

    const tx3 = await rewardRouter.batchCompoundForAccounts([user1.address, user2.address])
    await reportGasUsed(provider, tx1, "batchCompoundForAccounts gas used")

    expect(await stakedGmxTracker.stakedAmounts(user1.address)).gt(expandDecimals(4165, 18))
    expect(await stakedGmxTracker.stakedAmounts(user1.address)).lt(expandDecimals(4167, 18))
    expect(await stakedGmxTracker.depositBalances(user1.address, gmx.address)).eq(0)
    expect(await stakedGmxTracker.depositBalances(user1.address, esGmx.address)).gt(expandDecimals(4165, 18))
    expect(await stakedGmxTracker.depositBalances(user1.address, esGmx.address)).lt(expandDecimals(4167, 18))

    expect(await bonusGmxTracker.stakedAmounts(user1.address)).gt(expandDecimals(4165, 18))
    expect(await bonusGmxTracker.stakedAmounts(user1.address)).lt(expandDecimals(4167, 18))

    expect(await feeGmxTracker.stakedAmounts(user1.address)).gt(expandDecimals(4179, 18))
    expect(await feeGmxTracker.stakedAmounts(user1.address)).lt(expandDecimals(4180, 18))
    expect(await feeGmxTracker.depositBalances(user1.address, bonusGmxTracker.address)).gt(expandDecimals(4165, 18))
    expect(await feeGmxTracker.depositBalances(user1.address, bonusGmxTracker.address)).lt(expandDecimals(4167, 18))
    expect(await feeGmxTracker.depositBalances(user1.address, bnGmx.address)).gt("12900000000000000000") // 12.9
    expect(await feeGmxTracker.depositBalances(user1.address, bnGmx.address)).lt("13100000000000000000") // 13.1

    expect(await feeGlpTracker.stakedAmounts(user1.address)).eq("598300000000000000000") // 598.3
    expect(await stakedGlpTracker.stakedAmounts(user1.address)).eq("598300000000000000000")
    expect(await bnb.balanceOf(user1.address)).eq("993676666666666666") // ~0.99
  })

  it("mintAndStakeGlpETH, unstakeAndRedeemGlpETH", async () => {
    const receiver0 = newWallet()
    await expect(rewardRouter.connect(user0).mintAndStakeGlpETH(expandDecimals(300, 18), expandDecimals(300, 18), { value: 0 }))
      .to.be.revertedWith("RewardRouter: invalid msg.value")

    await expect(rewardRouter.connect(user0).mintAndStakeGlpETH(expandDecimals(300, 18), expandDecimals(300, 18), { value: expandDecimals(1, 18) }))
      .to.be.revertedWith("GlpManager: insufficient USDG output")

    await expect(rewardRouter.connect(user0).mintAndStakeGlpETH(expandDecimals(299, 18), expandDecimals(300, 18), { value: expandDecimals(1, 18) }))
      .to.be.revertedWith("GlpManager: insufficient GLP output")

    expect(await bnb.balanceOf(user0.address)).eq(0)
    expect(await bnb.balanceOf(vault.address)).eq(0)
    expect(await bnb.totalSupply()).eq(0)
    expect(await provider.getBalance(bnb.address)).eq(0)
    expect(await stakedGlpTracker.balanceOf(user0.address)).eq(0)

    await rewardRouter.connect(user0).mintAndStakeGlpETH(expandDecimals(299, 18), expandDecimals(299, 18), { value: expandDecimals(1, 18) })

    expect(await bnb.balanceOf(user0.address)).eq(0)
    expect(await bnb.balanceOf(vault.address)).eq(expandDecimals(1, 18))
    expect(await provider.getBalance(bnb.address)).eq(expandDecimals(1, 18))
    expect(await bnb.totalSupply()).eq(expandDecimals(1, 18))
    expect(await stakedGlpTracker.balanceOf(user0.address)).eq("299100000000000000000") // 299.1

    await expect(rewardRouter.connect(user0).unstakeAndRedeemGlpETH(expandDecimals(300, 18), expandDecimals(1, 18), receiver0.address))
      .to.be.revertedWith("RewardTracker: _amount exceeds stakedAmount")

    await expect(rewardRouter.connect(user0).unstakeAndRedeemGlpETH("299100000000000000000", expandDecimals(1, 18), receiver0.address))
      .to.be.revertedWith("GlpManager: cooldown duration not yet passed")

    await increaseTime(provider, 24 * 60 * 60 + 10)

    await expect(rewardRouter.connect(user0).unstakeAndRedeemGlpETH("299100000000000000000", expandDecimals(1, 18), receiver0.address))
      .to.be.revertedWith("GlpManager: insufficient output")

    await rewardRouter.connect(user0).unstakeAndRedeemGlpETH("299100000000000000000", "990000000000000000", receiver0.address)
    expect(await provider.getBalance(receiver0.address)).eq("994009000000000000") // 0.994009
    expect(await bnb.balanceOf(vault.address)).eq("5991000000000000") // 0.005991
    expect(await provider.getBalance(bnb.address)).eq("5991000000000000")
    expect(await bnb.totalSupply()).eq("5991000000000000")
  })

  it("gmx: signalTransfer, acceptTransfer", async () =>{
    await gmx.setMinter(wallet.address, true)
    await gmx.mint(user1.address, expandDecimals(200, 18))
    expect(await gmx.balanceOf(user1.address)).eq(expandDecimals(200, 18))
    await gmx.connect(user1).approve(stakedGmxTracker.address, expandDecimals(200, 18))
    await rewardRouter.connect(user1).stakeGmx(expandDecimals(200, 18))
    expect(await gmx.balanceOf(user1.address)).eq(0)

    await gmx.mint(user2.address, expandDecimals(200, 18))
    expect(await gmx.balanceOf(user2.address)).eq(expandDecimals(200, 18))
    await gmx.connect(user2).approve(stakedGmxTracker.address, expandDecimals(400, 18))
    await rewardRouter.connect(user2).stakeGmx(expandDecimals(200, 18))
    expect(await gmx.balanceOf(user2.address)).eq(0)

    await rewardRouter.connect(user2).signalTransfer(user1.address)

    await increaseTime(provider, 24 * 60 * 60)
    await mineBlock(provider)

    await rewardRouter.connect(user2).signalTransfer(user1.address)
    await rewardRouter.connect(user1).claim()

    await expect(rewardRouter.connect(user2).signalTransfer(user1.address))
      .to.be.revertedWith("RewardRouter: stakedGmxTracker.averageStakedAmounts > 0")

    await rewardRouter.connect(user2).signalTransfer(user3.address)

    await expect(rewardRouter.connect(user3).acceptTransfer(user1.address))
      .to.be.revertedWith("RewardRouter: transfer not signalled")

    await gmxVester.setBonusRewards(user2.address, expandDecimals(100, 18))

    expect(await stakedGmxTracker.depositBalances(user2.address, gmx.address)).eq(expandDecimals(200, 18))
    expect(await stakedGmxTracker.depositBalances(user2.address, esGmx.address)).eq(0)
    expect(await feeGmxTracker.depositBalances(user2.address, bnGmx.address)).eq(0)
    expect(await stakedGmxTracker.depositBalances(user3.address, gmx.address)).eq(0)
    expect(await stakedGmxTracker.depositBalances(user3.address, esGmx.address)).eq(0)
    expect(await feeGmxTracker.depositBalances(user3.address, bnGmx.address)).eq(0)
    expect(await gmxVester.transferredAverageStakedAmounts(user3.address)).eq(0)
    expect(await gmxVester.transferredCumulativeRewards(user3.address)).eq(0)
    expect(await gmxVester.bonusRewards(user2.address)).eq(expandDecimals(100, 18))
    expect(await gmxVester.bonusRewards(user3.address)).eq(0)
    expect(await gmxVester.getCombinedAveragedStakedAmount(user2.address)).eq(0)
    expect(await gmxVester.getCombinedAveragedStakedAmount(user3.address)).eq(0)
    expect(await gmxVester.getMaxVestableAmount(user2.address)).eq(expandDecimals(100, 18))
    expect(await gmxVester.getMaxVestableAmount(user3.address)).eq(0)
    expect(await gmxVester.getPairAmount(user2.address, expandDecimals(892, 18))).eq(0)
    expect(await gmxVester.getPairAmount(user3.address, expandDecimals(892, 18))).eq(0)

    await rewardRouter.connect(user3).acceptTransfer(user2.address)

    expect(await stakedGmxTracker.depositBalances(user2.address, gmx.address)).eq(0)
    expect(await stakedGmxTracker.depositBalances(user2.address, esGmx.address)).eq(0)
    expect(await feeGmxTracker.depositBalances(user2.address, bnGmx.address)).eq(0)
    expect(await stakedGmxTracker.depositBalances(user3.address, gmx.address)).eq(expandDecimals(200, 18))
    expect(await stakedGmxTracker.depositBalances(user3.address, esGmx.address)).gt(expandDecimals(892, 18))
    expect(await stakedGmxTracker.depositBalances(user3.address, esGmx.address)).lt(expandDecimals(893, 18))
    expect(await feeGmxTracker.depositBalances(user3.address, bnGmx.address)).gt("547000000000000000") // 0.547
    expect(await feeGmxTracker.depositBalances(user3.address, bnGmx.address)).lt("549000000000000000") // 0.548
    expect(await gmxVester.transferredAverageStakedAmounts(user3.address)).eq(expandDecimals(200, 18))
    expect(await gmxVester.transferredCumulativeRewards(user3.address)).gt(expandDecimals(892, 18))
    expect(await gmxVester.transferredCumulativeRewards(user3.address)).lt(expandDecimals(893, 18))
    expect(await gmxVester.bonusRewards(user2.address)).eq(0)
    expect(await gmxVester.bonusRewards(user3.address)).eq(expandDecimals(100, 18))
    expect(await gmxVester.getCombinedAveragedStakedAmount(user2.address)).eq(expandDecimals(200, 18))
    expect(await gmxVester.getCombinedAveragedStakedAmount(user3.address)).eq(expandDecimals(200, 18))
    expect(await gmxVester.getMaxVestableAmount(user2.address)).eq(0)
    expect(await gmxVester.getMaxVestableAmount(user3.address)).gt(expandDecimals(992, 18))
    expect(await gmxVester.getMaxVestableAmount(user3.address)).lt(expandDecimals(993, 18))
    expect(await gmxVester.getPairAmount(user2.address, expandDecimals(992, 18))).eq(0)
    expect(await gmxVester.getPairAmount(user3.address, expandDecimals(992, 18))).gt(expandDecimals(199, 18))
    expect(await gmxVester.getPairAmount(user3.address, expandDecimals(992, 18))).lt(expandDecimals(200, 18))

    await expect(rewardRouter.connect(user3).acceptTransfer(user1.address))
      .to.be.revertedWith("RewardRouter: transfer not signalled")
  })

  it("gmx, glp: signalTransfer, acceptTransfer", async () =>{
    await gmx.setMinter(wallet.address, true)
    await gmx.mint(gmxVester.address, expandDecimals(10000, 18))
    await gmx.mint(glpVester.address, expandDecimals(10000, 18))
    await eth.mint(feeGlpDistributor.address, expandDecimals(100, 18))
    await feeGlpDistributor.setTokensPerInterval("41335970000000") // 0.00004133597 ETH per second

    await bnb.mint(user1.address, expandDecimals(1, 18))
    await bnb.connect(user1).approve(glpManager.address, expandDecimals(1, 18))
    await rewardRouter.connect(user1).mintAndStakeGlp(
      bnb.address,
      expandDecimals(1, 18),
      expandDecimals(299, 18),
      expandDecimals(299, 18)
    )

    await bnb.mint(user2.address, expandDecimals(1, 18))
    await bnb.connect(user2).approve(glpManager.address, expandDecimals(1, 18))
    await rewardRouter.connect(user2).mintAndStakeGlp(
      bnb.address,
      expandDecimals(1, 18),
      expandDecimals(299, 18),
      expandDecimals(299, 18)
    )

    await gmx.mint(user1.address, expandDecimals(200, 18))
    expect(await gmx.balanceOf(user1.address)).eq(expandDecimals(200, 18))
    await gmx.connect(user1).approve(stakedGmxTracker.address, expandDecimals(200, 18))
    await rewardRouter.connect(user1).stakeGmx(expandDecimals(200, 18))
    expect(await gmx.balanceOf(user1.address)).eq(0)

    await gmx.mint(user2.address, expandDecimals(200, 18))
    expect(await gmx.balanceOf(user2.address)).eq(expandDecimals(200, 18))
    await gmx.connect(user2).approve(stakedGmxTracker.address, expandDecimals(400, 18))
    await rewardRouter.connect(user2).stakeGmx(expandDecimals(200, 18))
    expect(await gmx.balanceOf(user2.address)).eq(0)

    await rewardRouter.connect(user2).signalTransfer(user1.address)

    await increaseTime(provider, 24 * 60 * 60)
    await mineBlock(provider)

    await rewardRouter.connect(user2).signalTransfer(user1.address)
    await rewardRouter.connect(user1).compound()

    await expect(rewardRouter.connect(user2).signalTransfer(user1.address))
      .to.be.revertedWith("RewardRouter: stakedGmxTracker.averageStakedAmounts > 0")

    await rewardRouter.connect(user2).signalTransfer(user3.address)

    await expect(rewardRouter.connect(user3).acceptTransfer(user1.address))
      .to.be.revertedWith("RewardRouter: transfer not signalled")

    await gmxVester.setBonusRewards(user2.address, expandDecimals(100, 18))

    expect(await stakedGmxTracker.depositBalances(user2.address, gmx.address)).eq(expandDecimals(200, 18))
    expect(await stakedGmxTracker.depositBalances(user2.address, esGmx.address)).eq(0)
    expect(await stakedGmxTracker.depositBalances(user3.address, gmx.address)).eq(0)
    expect(await stakedGmxTracker.depositBalances(user3.address, esGmx.address)).eq(0)

    expect(await feeGmxTracker.depositBalances(user2.address, bnGmx.address)).eq(0)
    expect(await feeGmxTracker.depositBalances(user3.address, bnGmx.address)).eq(0)

    expect(await feeGlpTracker.depositBalances(user2.address, glp.address)).eq("299100000000000000000") // 299.1
    expect(await feeGlpTracker.depositBalances(user3.address, glp.address)).eq(0)

    expect(await stakedGlpTracker.depositBalances(user2.address, feeGlpTracker.address)).eq("299100000000000000000") // 299.1
    expect(await stakedGlpTracker.depositBalances(user3.address, feeGlpTracker.address)).eq(0)

    expect(await gmxVester.transferredAverageStakedAmounts(user3.address)).eq(0)
    expect(await gmxVester.transferredCumulativeRewards(user3.address)).eq(0)
    expect(await gmxVester.bonusRewards(user2.address)).eq(expandDecimals(100, 18))
    expect(await gmxVester.bonusRewards(user3.address)).eq(0)
    expect(await gmxVester.getCombinedAveragedStakedAmount(user2.address)).eq(0)
    expect(await gmxVester.getCombinedAveragedStakedAmount(user3.address)).eq(0)
    expect(await gmxVester.getMaxVestableAmount(user2.address)).eq(expandDecimals(100, 18))
    expect(await gmxVester.getMaxVestableAmount(user3.address)).eq(0)
    expect(await gmxVester.getPairAmount(user2.address, expandDecimals(892, 18))).eq(0)
    expect(await gmxVester.getPairAmount(user3.address, expandDecimals(892, 18))).eq(0)

    await rewardRouter.connect(user3).acceptTransfer(user2.address)

    expect(await stakedGmxTracker.depositBalances(user2.address, gmx.address)).eq(0)
    expect(await stakedGmxTracker.depositBalances(user2.address, esGmx.address)).eq(0)
    expect(await stakedGmxTracker.depositBalances(user3.address, gmx.address)).eq(expandDecimals(200, 18))
    expect(await stakedGmxTracker.depositBalances(user3.address, esGmx.address)).gt(expandDecimals(1785, 18))
    expect(await stakedGmxTracker.depositBalances(user3.address, esGmx.address)).lt(expandDecimals(1786, 18))

    expect(await feeGmxTracker.depositBalances(user2.address, bnGmx.address)).eq(0)
    expect(await feeGmxTracker.depositBalances(user3.address, bnGmx.address)).gt("547000000000000000") // 0.547
    expect(await feeGmxTracker.depositBalances(user3.address, bnGmx.address)).lt("549000000000000000") // 0.548

    expect(await feeGlpTracker.depositBalances(user2.address, glp.address)).eq(0)
    expect(await feeGlpTracker.depositBalances(user3.address, glp.address)).eq("299100000000000000000") // 299.1

    expect(await stakedGlpTracker.depositBalances(user2.address, feeGlpTracker.address)).eq(0)
    expect(await stakedGlpTracker.depositBalances(user3.address, feeGlpTracker.address)).eq("299100000000000000000") // 299.1

    expect(await gmxVester.transferredAverageStakedAmounts(user3.address)).eq(expandDecimals(200, 18))
    expect(await gmxVester.transferredCumulativeRewards(user3.address)).gt(expandDecimals(892, 18))
    expect(await gmxVester.transferredCumulativeRewards(user3.address)).lt(expandDecimals(893, 18))
    expect(await gmxVester.bonusRewards(user2.address)).eq(0)
    expect(await gmxVester.bonusRewards(user3.address)).eq(expandDecimals(100, 18))
    expect(await gmxVester.getCombinedAveragedStakedAmount(user2.address)).eq(expandDecimals(200, 18))
    expect(await gmxVester.getCombinedAveragedStakedAmount(user3.address)).eq(expandDecimals(200, 18))
    expect(await gmxVester.getMaxVestableAmount(user2.address)).eq(0)
    expect(await gmxVester.getMaxVestableAmount(user3.address)).gt(expandDecimals(992, 18))
    expect(await gmxVester.getMaxVestableAmount(user3.address)).lt(expandDecimals(993, 18))
    expect(await gmxVester.getPairAmount(user2.address, expandDecimals(992, 18))).eq(0)
    expect(await gmxVester.getPairAmount(user3.address, expandDecimals(992, 18))).gt(expandDecimals(199, 18))
    expect(await gmxVester.getPairAmount(user3.address, expandDecimals(992, 18))).lt(expandDecimals(200, 18))
    expect(await gmxVester.getPairAmount(user1.address, expandDecimals(892, 18))).gt(expandDecimals(199, 18))
    expect(await gmxVester.getPairAmount(user1.address, expandDecimals(892, 18))).lt(expandDecimals(200, 18))

    await rewardRouter.connect(user1).compound()

    await expect(rewardRouter.connect(user3).acceptTransfer(user1.address))
      .to.be.revertedWith("RewardRouter: transfer not signalled")

    await increaseTime(provider, 24 * 60 * 60)
    await mineBlock(provider)

    await rewardRouter.connect(user1).claim()
    await rewardRouter.connect(user2).claim()
    await rewardRouter.connect(user3).claim()

    expect(await gmxVester.getCombinedAveragedStakedAmount(user1.address)).gt(expandDecimals(1092, 18))
    expect(await gmxVester.getCombinedAveragedStakedAmount(user1.address)).lt(expandDecimals(1094, 18))
    expect(await gmxVester.getCombinedAveragedStakedAmount(user3.address)).gt(expandDecimals(1092, 18))
    expect(await gmxVester.getCombinedAveragedStakedAmount(user3.address)).lt(expandDecimals(1094, 18))

    expect(await gmxVester.getMaxVestableAmount(user2.address)).eq(0)
    expect(await gmxVester.getMaxVestableAmount(user3.address)).gt(expandDecimals(1885, 18))
    expect(await gmxVester.getMaxVestableAmount(user3.address)).lt(expandDecimals(1887, 18))
    expect(await gmxVester.getMaxVestableAmount(user1.address)).gt(expandDecimals(1785, 18))
    expect(await gmxVester.getMaxVestableAmount(user1.address)).lt(expandDecimals(1787, 18))

    expect(await gmxVester.getPairAmount(user2.address, expandDecimals(992, 18))).eq(0)
    expect(await gmxVester.getPairAmount(user3.address, expandDecimals(1885, 18))).gt(expandDecimals(1092, 18))
    expect(await gmxVester.getPairAmount(user3.address, expandDecimals(1885, 18))).lt(expandDecimals(1094, 18))
    expect(await gmxVester.getPairAmount(user1.address, expandDecimals(1785, 18))).gt(expandDecimals(1092, 18))
    expect(await gmxVester.getPairAmount(user1.address, expandDecimals(1785, 18))).lt(expandDecimals(1094, 18))

    await rewardRouter.connect(user1).compound()
    await rewardRouter.connect(user3).compound()

    expect(await feeGmxTracker.balanceOf(user1.address)).gt(expandDecimals(1992, 18))
    expect(await feeGmxTracker.balanceOf(user1.address)).lt(expandDecimals(1993, 18))

    await gmxVester.connect(user1).deposit(expandDecimals(1785, 18))

    expect(await feeGmxTracker.balanceOf(user1.address)).gt(expandDecimals(1991 - 1092, 18)) // 899
    expect(await feeGmxTracker.balanceOf(user1.address)).lt(expandDecimals(1993 - 1092, 18)) // 901

    expect(await feeGmxTracker.depositBalances(user1.address, bnGmx.address)).gt(expandDecimals(4, 18))
    expect(await feeGmxTracker.depositBalances(user1.address, bnGmx.address)).lt(expandDecimals(6, 18))

    await rewardRouter.connect(user1).unstakeGmx(expandDecimals(200, 18))
    await expect(rewardRouter.connect(user1).unstakeEsGmx(expandDecimals(699, 18)))
      .to.be.revertedWith("RewardTracker: burn amount exceeds balance")

    await rewardRouter.connect(user1).unstakeEsGmx(expandDecimals(599, 18))

    await increaseTime(provider, 24 * 60 * 60)
    await mineBlock(provider)

    expect(await feeGmxTracker.balanceOf(user1.address)).gt(expandDecimals(97, 18))
    expect(await feeGmxTracker.balanceOf(user1.address)).lt(expandDecimals(99, 18))

    expect(await esGmx.balanceOf(user1.address)).gt(expandDecimals(599, 18))
    expect(await esGmx.balanceOf(user1.address)).lt(expandDecimals(601, 18))

    expect(await gmx.balanceOf(user1.address)).eq(expandDecimals(200, 18))

    await gmxVester.connect(user1).withdraw()

    expect(await feeGmxTracker.balanceOf(user1.address)).gt(expandDecimals(1190, 18)) // 1190 - 98 => 1092
    expect(await feeGmxTracker.balanceOf(user1.address)).lt(expandDecimals(1191, 18))

    expect(await esGmx.balanceOf(user1.address)).gt(expandDecimals(2378, 18))
    expect(await esGmx.balanceOf(user1.address)).lt(expandDecimals(2380, 18))

    expect(await gmx.balanceOf(user1.address)).gt(expandDecimals(204, 18))
    expect(await gmx.balanceOf(user1.address)).lt(expandDecimals(206, 18))

    expect(await glpVester.getMaxVestableAmount(user3.address)).gt(expandDecimals(1785, 18))
    expect(await glpVester.getMaxVestableAmount(user3.address)).lt(expandDecimals(1787, 18))

    expect(await glpVester.getPairAmount(user3.address, expandDecimals(1785, 18))).gt(expandDecimals(298, 18))
    expect(await glpVester.getPairAmount(user3.address, expandDecimals(1785, 18))).lt(expandDecimals(300, 18))

    expect(await stakedGlpTracker.balanceOf(user3.address)).eq("299100000000000000000")

    expect(await esGmx.balanceOf(user3.address)).gt(expandDecimals(1785, 18))
    expect(await esGmx.balanceOf(user3.address)).lt(expandDecimals(1787, 18))

    expect(await gmx.balanceOf(user3.address)).eq(0)

    await glpVester.connect(user3).deposit(expandDecimals(1785, 18))

    expect(await stakedGlpTracker.balanceOf(user3.address)).gt(0)
    expect(await stakedGlpTracker.balanceOf(user3.address)).lt(expandDecimals(1, 18))

    expect(await esGmx.balanceOf(user3.address)).gt(0)
    expect(await esGmx.balanceOf(user3.address)).lt(expandDecimals(1, 18))

    expect(await gmx.balanceOf(user3.address)).eq(0)

    await expect(rewardRouter.connect(user3).unstakeAndRedeemGlp(
      bnb.address,
      expandDecimals(1, 18),
      0,
      user3.address
    )).to.be.revertedWith("RewardTracker: burn amount exceeds balance")

    await increaseTime(provider, 24 * 60 * 60)
    await mineBlock(provider)

    await glpVester.connect(user3).withdraw()

    expect(await stakedGlpTracker.balanceOf(user3.address)).eq("299100000000000000000")

    expect(await esGmx.balanceOf(user3.address)).gt(expandDecimals(1785 - 5, 18))
    expect(await esGmx.balanceOf(user3.address)).lt(expandDecimals(1787 - 5, 18))

    expect(await gmx.balanceOf(user3.address)).gt(expandDecimals(4, 18))
    expect(await gmx.balanceOf(user3.address)).lt(expandDecimals(6, 18))

    expect(await feeGmxTracker.balanceOf(user1.address)).gt(expandDecimals(1190, 18))
    expect(await feeGmxTracker.balanceOf(user1.address)).lt(expandDecimals(1191, 18))

    expect(await esGmx.balanceOf(user1.address)).gt(expandDecimals(2379, 18))
    expect(await esGmx.balanceOf(user1.address)).lt(expandDecimals(2381, 18))

    expect(await gmx.balanceOf(user1.address)).gt(expandDecimals(204, 18))
    expect(await gmx.balanceOf(user1.address)).lt(expandDecimals(206, 18))

    await gmxVester.connect(user1).deposit(expandDecimals(365 * 2, 18))

    expect(await feeGmxTracker.balanceOf(user1.address)).gt(expandDecimals(743, 18)) // 1190 - 743 => 447
    expect(await feeGmxTracker.balanceOf(user1.address)).lt(expandDecimals(754, 18))

    expect(await gmxVester.claimable(user1.address)).eq(0)

    await increaseTime(provider, 48 * 60 * 60)
    await mineBlock(provider)

    expect(await gmxVester.claimable(user1.address)).gt("3900000000000000000") // 3.9
    expect(await gmxVester.claimable(user1.address)).lt("4100000000000000000") // 4.1

    await gmxVester.connect(user1).deposit(expandDecimals(365, 18))

    expect(await feeGmxTracker.balanceOf(user1.address)).gt(expandDecimals(522, 18)) // 743 - 522 => 221
    expect(await feeGmxTracker.balanceOf(user1.address)).lt(expandDecimals(524, 18))

    await increaseTime(provider, 48 * 60 * 60)
    await mineBlock(provider)

    expect(await gmxVester.claimable(user1.address)).gt("9900000000000000000") // 9.9
    expect(await gmxVester.claimable(user1.address)).lt("10100000000000000000") // 10.1

    expect(await gmx.balanceOf(user1.address)).gt(expandDecimals(204, 18))
    expect(await gmx.balanceOf(user1.address)).lt(expandDecimals(206, 18))

    await gmxVester.connect(user1).claim()

    expect(await gmx.balanceOf(user1.address)).gt(expandDecimals(214, 18))
    expect(await gmx.balanceOf(user1.address)).lt(expandDecimals(216, 18))

    await gmxVester.connect(user1).deposit(expandDecimals(365, 18))
    expect(await gmxVester.balanceOf(user1.address)).gt(expandDecimals(1449, 18)) // 365 * 4 => 1460, 1460 - 10 => 1450
    expect(await gmxVester.balanceOf(user1.address)).lt(expandDecimals(1451, 18))
    expect(await gmxVester.getVestedAmount(user1.address)).eq(expandDecimals(1460, 18))

    expect(await feeGmxTracker.balanceOf(user1.address)).gt(expandDecimals(303, 18)) // 522 - 303 => 219
    expect(await feeGmxTracker.balanceOf(user1.address)).lt(expandDecimals(304, 18))

    await increaseTime(provider, 48 * 60 * 60)
    await mineBlock(provider)

    expect(await gmxVester.claimable(user1.address)).gt("7900000000000000000") // 7.9
    expect(await gmxVester.claimable(user1.address)).lt("8100000000000000000") // 8.1

    await gmxVester.connect(user1).withdraw()

    expect(await feeGmxTracker.balanceOf(user1.address)).gt(expandDecimals(1190, 18))
    expect(await feeGmxTracker.balanceOf(user1.address)).lt(expandDecimals(1191, 18))

    expect(await gmx.balanceOf(user1.address)).gt(expandDecimals(222, 18))
    expect(await gmx.balanceOf(user1.address)).lt(expandDecimals(224, 18))

    expect(await esGmx.balanceOf(user1.address)).gt(expandDecimals(2360, 18))
    expect(await esGmx.balanceOf(user1.address)).lt(expandDecimals(2362, 18))

    await gmxVester.connect(user1).deposit(expandDecimals(365, 18))

    await increaseTime(provider, 500 * 24 * 60 * 60)
    await mineBlock(provider)

    expect(await gmxVester.claimable(user1.address)).eq(expandDecimals(365, 18))

    await gmxVester.connect(user1).withdraw()

    expect(await gmx.balanceOf(user1.address)).gt(expandDecimals(222 + 365, 18))
    expect(await gmx.balanceOf(user1.address)).lt(expandDecimals(224 + 365, 18))

    expect(await esGmx.balanceOf(user1.address)).gt(expandDecimals(2360 - 365, 18))
    expect(await esGmx.balanceOf(user1.address)).lt(expandDecimals(2362 - 365, 18))
  })
})
