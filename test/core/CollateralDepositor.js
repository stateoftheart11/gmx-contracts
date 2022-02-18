const { expect, use } = require("chai")
const { solidity } = require("ethereum-waffle")
const { deployContract } = require("../shared/fixtures")
const { expandDecimals, getBlockTime, increaseTime, mineBlock, reportGasUsed } = require("../shared/utilities")
const { toChainlinkPrice } = require("../shared/chainlink")
const { toUsd, toNormalizedPrice } = require("../shared/units")
const { initVault, getBnbConfig, getBtcConfig, getDaiConfig, validateVaultBalance } = require("./Vault/helpers")

use(solidity)

describe("CollateralDepositor", function () {
  const provider = waffle.provider
  const [wallet, user0, user1, user2, user3] = provider.getWallets()
  let vault
  let vaultUtils
  let vaultPriceFeed
  let collateralDepositor
  let usdg
  let router
  let bnb
  let bnbPriceFeed
  let btc
  let btcPriceFeed
  let dai
  let daiPriceFeed
  let distributor0
  let yieldTracker0

  let glpManager
  let glp

  beforeEach(async () => {
    bnb = await deployContract("Token", [])
    bnbPriceFeed = await deployContract("PriceFeed", [])

    btc = await deployContract("Token", [])
    btcPriceFeed = await deployContract("PriceFeed", [])

    dai = await deployContract("Token", [])
    daiPriceFeed = await deployContract("PriceFeed", [])

    vault = await deployContract("Vault", [])
    usdg = await deployContract("USDG", [vault.address])
    router = await deployContract("Router", [vault.address, usdg.address, bnb.address])
    vaultPriceFeed = await deployContract("VaultPriceFeed", [])

    const initVaultResult = await initVault(vault, router, usdg, vaultPriceFeed)
    vaultUtils = initVaultResult.vaultUtils

    distributor0 = await deployContract("TimeDistributor", [])
    yieldTracker0 = await deployContract("YieldTracker", [usdg.address])

    await yieldTracker0.setDistributor(distributor0.address)
    await distributor0.setDistribution([yieldTracker0.address], [1000], [bnb.address])

    await bnb.mint(distributor0.address, 5000)
    await usdg.setYieldTrackers([yieldTracker0.address])

    await vaultPriceFeed.setTokenConfig(bnb.address, bnbPriceFeed.address, 8, false)
    await vaultPriceFeed.setTokenConfig(btc.address, btcPriceFeed.address, 8, false)
    await vaultPriceFeed.setTokenConfig(dai.address, daiPriceFeed.address, 8, false)

    glp = await deployContract("GLP", [])
    glpManager = await deployContract("GlpManager", [vault.address, usdg.address, glp.address, 24 * 60 * 60])

    collateralDepositor = await deployContract("CollateralDepositor", [router.address, vault.address, bnb.address, 50])

    await daiPriceFeed.setLatestAnswer(toChainlinkPrice(1))
    await vault.setTokenConfig(...getDaiConfig(dai, daiPriceFeed))

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(60000))
    await vault.setTokenConfig(...getBtcConfig(btc, btcPriceFeed))

    await bnbPriceFeed.setLatestAnswer(toChainlinkPrice(300))
    await vault.setTokenConfig(...getBnbConfig(bnb, bnbPriceFeed))
  })

  it("inits", async () => {
    expect(await collateralDepositor.router()).eq(router.address)
    expect(await collateralDepositor.vault()).eq(vault.address)
    expect(await collateralDepositor.weth()).eq(bnb.address)
    expect(await collateralDepositor.depositFee()).eq(50)
    expect(await collateralDepositor.gov()).eq(wallet.address)
  })

  it("setDepositFee", async () => {
    await expect(collateralDepositor.connect(user0).setDepositFee(10))
      .to.be.revertedWith("Governable: forbidden")

    expect(await collateralDepositor.depositFee()).eq(50)
    await collateralDepositor.connect(wallet).setDepositFee(10)
    expect(await collateralDepositor.depositFee()).eq(10)
  })

  it("approve", async () => {
    await expect(collateralDepositor.connect(user0).approve(bnb.address, user1.address, 10))
      .to.be.revertedWith("Governable: forbidden")

    expect(await bnb.allowance(collateralDepositor.address, user1.address)).eq(0)
    await collateralDepositor.connect(wallet).approve(bnb.address, user1.address, 10)
    expect(await bnb.allowance(collateralDepositor.address, user1.address)).eq(10)
  })

  it("depositCollateral", async () => {
    const timelock = await deployContract("Timelock", [
      wallet.address,
      5 * 24 * 60 * 60,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      expandDecimals(1000, 18)
    ])

    await vault.setGov(timelock.address)

    await expect(collateralDepositor.connect(user0).depositCollateral(btc.address, btc.address, true, expandDecimals(1, 7)))
      .to.be.revertedWith("Router: invalid plugin")

    await router.addPlugin(collateralDepositor.address)

    await expect(collateralDepositor.connect(user0).depositCollateral(btc.address, btc.address, true, expandDecimals(1, 7)))
      .to.be.revertedWith("Router: plugin not approved")

    await router.connect(user0).approvePlugin(collateralDepositor.address)
    await btc.connect(user0).approve(router.address, expandDecimals(1, 8))

    await btc.mint(user0.address, expandDecimals(1, 8))

    await expect(collateralDepositor.connect(user0).depositCollateral(btc.address, btc.address, true, expandDecimals(1, 7)))
      .to.be.revertedWith("Timelock: forbidden")

    await timelock.setContractHandler(collateralDepositor.address, true)

    await expect(collateralDepositor.connect(user0).depositCollateral(btc.address, btc.address, true, expandDecimals(1, 7)))
      .to.be.revertedWith("VaultUtils: leverage is too low")

    await btc.mint(user1.address, expandDecimals(1, 8))
    await btc.connect(user1).approve(router.address, expandDecimals(1, 8))
    await router.connect(user1).swap([btc.address, usdg.address], expandDecimals(1, 8), expandDecimals(59000, 18), user1.address)

    await dai.mint(user1.address, expandDecimals(30000, 18))
    await dai.connect(user1).approve(router.address, expandDecimals(30000, 18))
    await router.connect(user1).swap([dai.address, usdg.address], expandDecimals(30000, 18), expandDecimals(29000, 18), user1.address)

    await dai.mint(user0.address, expandDecimals(200, 18))
    await dai.connect(user0).approve(router.address, expandDecimals(200, 18))
    await router.connect(user0).increasePosition([dai.address, btc.address], btc.address, expandDecimals(200, 18), "332333", toUsd(2000), true, toNormalizedPrice(60000))

    let position = await vault.getPosition(user0.address, btc.address, btc.address, true)
    expect(position[0]).eq(toUsd(2000)) // size
    expect(position[1]).eq("197399800000000000000000000000000") // collateral, 197.3998
    expect(position[2]).eq(toNormalizedPrice(60000)) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq("3333333") // reserveAmount
    expect(position[5]).eq(0) // realisedPnl
    expect(position[6]).eq(true) // hasProfit

    await collateralDepositor.connect(user0).depositCollateral(btc.address, btc.address, true, "500000")

    position = await vault.getPosition(user0.address, btc.address, btc.address, true)
    expect(position[0]).eq(toUsd(2000)) // size
    expect(position[1]).eq("495899800000000000000000000000000") // collateral, 495.8998, 495.8998 - 197.3998 => 298.5, 1.5 for fees
    expect(position[2]).eq(toNormalizedPrice(60000)) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq("3333333") // reserveAmount
    expect(position[5]).eq(0) // realisedPnl
    expect(position[6]).eq(true) // hasProfit
  })

  it("depositCollateralETH", async () => {
    const timelock = await deployContract("Timelock", [
      wallet.address,
      5 * 24 * 60 * 60,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      expandDecimals(1000, 18)
    ])

    await vault.setGov(timelock.address)

    await expect(collateralDepositor.connect(user0).depositCollateralETH({ value: expandDecimals(1, 18) }))
      .to.be.revertedWith("Timelock: forbidden")

    await timelock.setContractHandler(collateralDepositor.address, true)

    await expect(collateralDepositor.connect(user0).depositCollateralETH({ value: expandDecimals(1, 18) }))
      .to.be.revertedWith("Router: invalid plugin")

    await router.addPlugin(collateralDepositor.address)

    await expect(collateralDepositor.connect(user0).depositCollateralETH({ value: expandDecimals(1, 18) }))
      .to.be.revertedWith("Router: plugin not approved")

    await router.connect(user0).approvePlugin(collateralDepositor.address)

    await expect(collateralDepositor.connect(user0).depositCollateralETH({ value: expandDecimals(1, 18) }))
      .to.be.revertedWith("VaultUtils: leverage is too low")

    await bnb.mint(user1.address, expandDecimals(100, 18))
    await bnb.connect(user1).approve(router.address, expandDecimals(100, 18))
    await router.connect(user1).swap([bnb.address, usdg.address], expandDecimals(100, 18), expandDecimals(29000, 18), user1.address)

    await dai.mint(user1.address, expandDecimals(30000, 18))
    await dai.connect(user1).approve(router.address, expandDecimals(30000, 18))
    await router.connect(user1).swap([dai.address, usdg.address], expandDecimals(30000, 18), expandDecimals(29000, 18), user1.address)

    await dai.mint(user0.address, expandDecimals(200, 18))
    await dai.connect(user0).approve(router.address, expandDecimals(200, 18))
    await router.connect(user0).increasePosition([dai.address, bnb.address], bnb.address, expandDecimals(200, 18), "332333", toUsd(2000), true, toNormalizedPrice(300))

    let position = await vault.getPosition(user0.address, bnb.address, bnb.address, true)
    expect(position[0]).eq(toUsd(2000)) // size
    expect(position[1]).eq("197399999999999999800000000000000") // collateral, 197.4
    expect(position[2]).eq(toNormalizedPrice(300)) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq("6666666666666666666") // reserveAmount
    expect(position[5]).eq(0) // realisedPnl
    expect(position[6]).eq(true) // hasProfit

    await collateralDepositor.connect(user0).depositCollateralETH({ value: expandDecimals(1, 18) })

    position = await vault.getPosition(user0.address, bnb.address, bnb.address, true)
    expect(position[0]).eq(toUsd(2000)) // size
    expect(position[1]).eq("495899999999999999800000000000000") // collateral, 495.9, 495.9 - 197.4 => 298.5, 1.5 for fees
    expect(position[2]).eq(toNormalizedPrice(300)) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq("6666666666666666666") // reserveAmount
    expect(position[5]).eq(0) // realisedPnl
    expect(position[6]).eq(true) // hasProfit
  })
})
