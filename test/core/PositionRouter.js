const { expect, use } = require("chai")
const { solidity } = require("ethereum-waffle")
const { deployContract } = require("../shared/fixtures")
const { expandDecimals, getBlockTime, increaseTime, mineBlock, reportGasUsed, newWallet } = require("../shared/utilities")
const { toChainlinkPrice } = require("../shared/chainlink")
const { toUsd, toNormalizedPrice } = require("../shared/units")
const { initVault, getBnbConfig, getBtcConfig, getDaiConfig } = require("./Vault/helpers")

use(solidity)

describe("PositionRouter", function () {
  const { AddressZero, HashZero } = ethers.constants
  const provider = waffle.provider
  const [wallet, positionKeeper, user0, user1, user2, user3, tokenManager, mintReceiver] = provider.getWallets()
  const depositFee = 50
  const minExecutionFee = 4000
  let vault
  let timelock
  let usdg
  let router
  let positionRouter
  let referralStorage
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
  let distributor0
  let yieldTracker0
  let reader

  beforeEach(async () => {
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
    timelock = await deployContract("Timelock", [
      wallet.address,
      5 * 24 * 60 * 60,
      AddressZero,
      tokenManager.address,
      mintReceiver.address,
      expandDecimals(1000, 18),
      10, // marginFeeBasisPoints 0.1%
      500, // maxMarginFeeBasisPoints 5%
    ])

    usdg = await deployContract("USDG", [vault.address])
    router = await deployContract("Router", [vault.address, usdg.address, bnb.address])
    positionRouter = await deployContract("PositionRouter", [vault.address, router.address, bnb.address, depositFee, minExecutionFee])
    referralStorage = await deployContract("ReferralStorage", [])
    vaultPriceFeed = await deployContract("VaultPriceFeed", [])
    await positionRouter.setReferralStorage(referralStorage.address)
    await referralStorage.setHandler(positionRouter.address, true)

    await initVault(vault, router, usdg, vaultPriceFeed)

    distributor0 = await deployContract("TimeDistributor", [])
    yieldTracker0 = await deployContract("YieldTracker", [usdg.address])

    await yieldTracker0.setDistributor(distributor0.address)
    await distributor0.setDistribution([yieldTracker0.address], [1000], [bnb.address])

    await bnb.mint(distributor0.address, 5000)
    await usdg.setYieldTrackers([yieldTracker0.address])

    reader = await deployContract("Reader", [])

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

    await bnb.connect(user3).deposit({ value: expandDecimals(100, 18) })

    await vault.setIsLeverageEnabled(false)
    await vault.setGov(timelock.address)
  })

  it("inits", async () => {
    expect(await positionRouter.vault()).eq(vault.address)
    expect(await positionRouter.router()).eq(router.address)
    expect(await positionRouter.weth()).eq(bnb.address)
    expect(await positionRouter.depositFee()).eq(depositFee)
    expect(await positionRouter.minExecutionFee()).eq(minExecutionFee)
    expect(await positionRouter.admin()).eq(wallet.address)
    expect(await positionRouter.gov()).eq(wallet.address)
  })

  it("setAdmin", async () => {
    await expect(positionRouter.connect(user0).setAdmin(user1.address))
      .to.be.revertedWith("Governable: forbidden")

    await positionRouter.setGov(user0.address)

    expect(await positionRouter.admin()).eq(wallet.address)
    await positionRouter.connect(user0).setAdmin(user1.address)
    expect(await positionRouter.admin()).eq(user1.address)
  })

  it("setDepositFee", async () => {
    await expect(positionRouter.connect(user0).setDepositFee(25))
      .to.be.revertedWith("BasePositionManager: forbidden")

    await positionRouter.setAdmin(user0.address)

    expect(await positionRouter.depositFee()).eq(depositFee)
    await positionRouter.connect(user0).setDepositFee(25)
    expect(await positionRouter.depositFee()).eq(25)
  })

  it("setReferralStorage", async () => {
    await expect(positionRouter.connect(user0).setReferralStorage(user1.address))
      .to.be.revertedWith("BasePositionManager: forbidden")

    await positionRouter.setAdmin(user0.address)

    expect(await positionRouter.referralStorage()).eq(referralStorage.address)
    await positionRouter.connect(user0).setReferralStorage(user1.address)
    expect(await positionRouter.referralStorage()).eq(user1.address)
  })

  it("setMaxGlobalSizes", async () => {
    const tokens = [bnb.address, btc.address, eth.address]
    const maxGlobalLongSizes = [7, 20, 15]
    const maxGlobalShortSizes = [3, 12, 8]

    await expect(positionRouter.connect(user0).setMaxGlobalSizes(tokens, maxGlobalLongSizes, maxGlobalShortSizes))
      .to.be.revertedWith("BasePositionManager: forbidden")

    await positionRouter.setAdmin(user0.address)

    expect(await positionRouter.maxGlobalLongSizes(bnb.address)).eq(0)
    expect(await positionRouter.maxGlobalLongSizes(btc.address)).eq(0)
    expect(await positionRouter.maxGlobalLongSizes(eth.address)).eq(0)

    expect(await positionRouter.maxGlobalShortSizes(bnb.address)).eq(0)
    expect(await positionRouter.maxGlobalShortSizes(btc.address)).eq(0)
    expect(await positionRouter.maxGlobalShortSizes(eth.address)).eq(0)

    await positionRouter.connect(user0).setMaxGlobalSizes(tokens, maxGlobalLongSizes, maxGlobalShortSizes)

    expect(await positionRouter.maxGlobalLongSizes(bnb.address)).eq(7)
    expect(await positionRouter.maxGlobalLongSizes(btc.address)).eq(20)
    expect(await positionRouter.maxGlobalLongSizes(eth.address)).eq(15)

    expect(await positionRouter.maxGlobalShortSizes(bnb.address)).eq(3)
    expect(await positionRouter.maxGlobalShortSizes(btc.address)).eq(12)
    expect(await positionRouter.maxGlobalShortSizes(eth.address)).eq(8)
  })

  it("approve", async () => {
    await expect(positionRouter.connect(user0).approve(bnb.address, user1.address, 100))
      .to.be.revertedWith("Governable: forbidden")

    await positionRouter.setGov(user0.address)

    expect(await bnb.allowance(positionRouter.address, user1.address)).eq(0)
    await positionRouter.connect(user0).approve(bnb.address, user1.address, 100)
    expect(await bnb.allowance(positionRouter.address, user1.address)).eq(100)
  })

  it("sendValue", async () => {
    await expect(positionRouter.connect(user0).sendValue(user1.address, 0))
      .to.be.revertedWith("Governable: forbidden")

    await positionRouter.setGov(user0.address)

    await positionRouter.connect(user0).sendValue(user1.address, 0)
  })

  it("setPositionKeeper", async () => {
    await expect(positionRouter.connect(user0).setPositionKeeper(user1.address, true))
      .to.be.revertedWith("BasePositionManager: forbidden")

    await positionRouter.setAdmin(user0.address)

    expect(await positionRouter.isPositionKeeper(user1.address)).eq(false)
    await positionRouter.connect(user0).setPositionKeeper(user1.address, true)
    expect(await positionRouter.isPositionKeeper(user1.address)).eq(true)

    await positionRouter.connect(user0).setPositionKeeper(user1.address, false)
    expect(await positionRouter.isPositionKeeper(user1.address)).eq(false)
  })

  it("setMinExecutionFee", async () => {
    await expect(positionRouter.connect(user0).setMinExecutionFee("7000"))
      .to.be.revertedWith("BasePositionManager: forbidden")

    await positionRouter.setAdmin(user0.address)

    expect(await positionRouter.minExecutionFee()).eq(minExecutionFee)
    await positionRouter.connect(user0).setMinExecutionFee("7000")
    expect(await positionRouter.minExecutionFee()).eq("7000")
  })

  it("setIsLeverageEnabled", async () => {
    await expect(positionRouter.connect(user0).setIsLeverageEnabled(false))
      .to.be.revertedWith("BasePositionManager: forbidden")

    await positionRouter.setAdmin(user0.address)

    expect(await positionRouter.isLeverageEnabled()).eq(true)
    await positionRouter.connect(user0).setIsLeverageEnabled(false)
    expect(await positionRouter.isLeverageEnabled()).eq(false)
  })

  it("setDelayValues", async () => {
    await expect(positionRouter.connect(user0).setDelayValues(7, 21, 600))
      .to.be.revertedWith("BasePositionManager: forbidden")

    await positionRouter.setAdmin(user0.address)

    expect(await positionRouter.minBlockDelayKeeper()).eq(0)
    expect(await positionRouter.minTimeDelayPublic()).eq(0)
    expect(await positionRouter.maxTimeDelay()).eq(0)

    await positionRouter.connect(user0).setDelayValues(7, 21, 600)

    expect(await positionRouter.minBlockDelayKeeper()).eq(7)
    expect(await positionRouter.minTimeDelayPublic()).eq(21)
    expect(await positionRouter.maxTimeDelay()).eq(600)
  })

  it("createIncreasePosition, executeIncreasePosition, cancelIncreasePosition", async () => {
    const referralCode = "0x0000000000000000000000000000000000000000000000000000000000000123"

    const params = [
      [dai.address, bnb.address], // _path
      bnb.address, // _indexToken
      expandDecimals(600, 18), // _amountIn
      expandDecimals(1, 18), // _minOut
      toUsd(6000), // _sizeDelta
      true, // _isLong
      toUsd(300), // _acceptablePrice
    ]

    await expect(positionRouter.connect(user0).createIncreasePosition(...params.concat([3000, referralCode])))
      .to.be.revertedWith("PositionRouter: invalid executionFee")

    await expect(positionRouter.connect(user0).createIncreasePosition(...params.concat([4000, referralCode])))
      .to.be.revertedWith("PositionRouter: invalid msg.value")

    await expect(positionRouter.connect(user0).createIncreasePosition(...params.concat([4000, referralCode]), { value: 3000 }))
      .to.be.revertedWith("PositionRouter: invalid msg.value")

    params[0] = []
    await expect(positionRouter.connect(user0).createIncreasePosition(...params.concat([4000, referralCode]), { value: 4000 }))
      .to.be.revertedWith("PositionRouter: invalid _path length")

    params[0] = [dai.address, bnb.address, bnb.address]

    await expect(positionRouter.connect(user0).createIncreasePosition(...params.concat([4000, referralCode]), { value: 4000 }))
      .to.be.revertedWith("PositionRouter: invalid _path length")

    params[0] = [dai.address, bnb.address]

    await expect(positionRouter.connect(user0).createIncreasePosition(...params.concat([4000, referralCode]), { value: 4000 }))
      .to.be.revertedWith("Router: invalid plugin")

    await router.addPlugin(positionRouter.address)

    await expect(positionRouter.connect(user0).createIncreasePosition(...params.concat([4000, referralCode]), { value: 4000 }))
      .to.be.revertedWith("Router: plugin not approved")

    await router.connect(user0).approvePlugin(positionRouter.address)

    await expect(positionRouter.connect(user0).createIncreasePosition(...params.concat([4000, referralCode]), { value: 4000 }))
      .to.be.revertedWith("ERC20: transfer amount exceeds balance")

    await dai.mint(user0.address, expandDecimals(600, 18))

    await expect(positionRouter.connect(user0).createIncreasePosition(...params.concat([4000, referralCode]), { value: 4000 }))
      .to.be.revertedWith("ERC20: transfer amount exceeds allowance")

    await dai.connect(user0).approve(router.address, expandDecimals(600, 18))

    let key = await positionRouter.getRequestKey(user0.address, 1)
    let request = await positionRouter.increasePositionRequests(key)

    expect(await referralStorage.traderReferralCodes(user0.address)).eq(HashZero)
    expect(await dai.balanceOf(positionRouter.address)).eq(0)
    expect(await positionRouter.increasePositionsIndex(user0.address)).eq(0)

    expect(request.account).eq(AddressZero)
    expect(request.path).eq(undefined)
    expect(request.indexToken).eq(AddressZero)
    expect(request.amountIn).eq(0)
    expect(request.minOut).eq(0)
    expect(request.sizeDelta).eq(0)
    expect(request.isLong).eq(false)
    expect(request.acceptablePrice).eq(0)
    expect(request.executionFee).eq(0)
    expect(request.blockNumber).eq(0)
    expect(request.blockTime).eq(0)
    expect(request.hasCollateralInETH).eq(false)

    let queueLengths = await positionRouter.getRequestQueueLengths()
    expect(queueLengths[0]).eq(0) // increasePositionRequestKeysStart
    expect(queueLengths[1]).eq(0) // increasePositionRequestKeys.length
    expect(queueLengths[2]).eq(0) // decreasePositionRequestKeysStart
    expect(queueLengths[3]).eq(0) // decreasePositionRequestKeys.length

    expect(await provider.getBalance(positionRouter.address)).eq(0)
    expect(await bnb.balanceOf(positionRouter.address)).eq(0)
    expect(await dai.balanceOf(positionRouter.address)).eq(0)

    const tx0 = await positionRouter.connect(user0).createIncreasePosition(...params.concat([4000, referralCode]), { value: 4000 })
    await reportGasUsed(provider, tx0, "createIncreasePosition gas used")

    expect(await provider.getBalance(positionRouter.address)).eq(0)
    expect(await bnb.balanceOf(positionRouter.address)).eq(4000)
    expect(await dai.balanceOf(positionRouter.address)).eq(expandDecimals(600, 18))

    const blockNumber = await provider.getBlockNumber()
    const blockTime = await getBlockTime(provider)

    request = await positionRouter.increasePositionRequests(key)

    expect(await referralStorage.traderReferralCodes(user0.address)).eq(referralCode)
    expect(await dai.balanceOf(positionRouter.address)).eq(expandDecimals(600, 18))
    expect(await positionRouter.increasePositionsIndex(user0.address)).eq(1)

    expect(request.account).eq(user0.address)
    expect(request.path).eq(undefined)
    expect(request.indexToken).eq(bnb.address)
    expect(request.amountIn).eq(expandDecimals(600, 18))
    expect(request.minOut).eq(expandDecimals(1, 18))
    expect(request.sizeDelta).eq(toUsd(6000))
    expect(request.isLong).eq(true)
    expect(request.acceptablePrice).eq(toUsd(300))
    expect(request.executionFee).eq(4000)
    expect(request.blockNumber).eq(blockNumber)
    expect(request.blockTime).eq(blockTime)
    expect(request.hasCollateralInETH).eq(false)

    queueLengths = await positionRouter.getRequestQueueLengths()
    expect(queueLengths[0]).eq(0) // increasePositionRequestKeysStart
    expect(queueLengths[1]).eq(1) // increasePositionRequestKeys.length
    expect(queueLengths[2]).eq(0) // decreasePositionRequestKeysStart
    expect(queueLengths[3]).eq(0) // decreasePositionRequestKeys.length

    await positionRouter.setDelayValues(5, 300, 500)

    const executionFeeReceiver = newWallet()
    await expect(positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address))
      .to.be.revertedWith("PositionRouter: forbidden")

    await positionRouter.setPositionKeeper(positionKeeper.address, true)

    // executeIncreasePosition will return without error and without executing the position if the minBlockDelayKeeper has not yet passed
    await positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address)

    request = await positionRouter.increasePositionRequests(key)
    expect(request.account).eq(user0.address)

    await mineBlock(provider)

    await expect(positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address))
      .to.be.revertedWith("Vault: poolAmount exceeded")

    await bnb.mint(vault.address, expandDecimals(30, 18))
    await vault.buyUSDG(bnb.address, user1.address)

    await expect(positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address))
      .to.be.revertedWith("Timelock: forbidden")

    await timelock.setContractHandler(positionRouter.address, true)

    await expect(positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address))
      .to.be.revertedWith("Vault: leverage not enabled")

    await timelock.setShouldToggleIsLeverageEnabled(true)

    let position = await vault.getPosition(user0.address, bnb.address, bnb.address, true)
    expect(position[0]).eq(0) // size
    expect(position[1]).eq(0) // collateral
    expect(position[2]).eq(0) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq(0) // reserveAmount
    expect(position[5]).eq(0) // realisedPnl
    expect(position[6]).eq(true) // hasProfit
    expect(position[7]).eq(0) // lastIncreasedTime

    expect(await provider.getBalance(executionFeeReceiver.address)).eq(0)

    const tx1 = await positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address)
    await reportGasUsed(provider, tx1, "executeIncreasePosition gas used")

    expect(await provider.getBalance(positionRouter.address)).eq(0)
    expect(await bnb.balanceOf(positionRouter.address)).eq(0)
    expect(await dai.balanceOf(positionRouter.address)).eq(0)

    request = await positionRouter.increasePositionRequests(key)

    expect(request.account).eq(AddressZero)
    expect(request.path).eq(undefined)
    expect(request.indexToken).eq(AddressZero)
    expect(request.amountIn).eq(0)
    expect(request.minOut).eq(0)
    expect(request.sizeDelta).eq(0)
    expect(request.isLong).eq(false)
    expect(request.acceptablePrice).eq(0)
    expect(request.executionFee).eq(0)
    expect(request.blockNumber).eq(0)
    expect(request.blockTime).eq(0)
    expect(request.hasCollateralInETH).eq(false)

    position = await vault.getPosition(user0.address, bnb.address, bnb.address, true)
    expect(position[0]).eq(toUsd(6000)) // size
    expect(position[1]).eq("592200000000000000000000000000000") // collateral, 592.2
    expect(position[2]).eq(toUsd(300)) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq(expandDecimals(20, 18)) // reserveAmount
    expect(position[5]).eq(0) // realisedPnl
    expect(position[6]).eq(true) // hasProfit

    expect(await provider.getBalance(executionFeeReceiver.address)).eq(4000)

    queueLengths = await positionRouter.getRequestQueueLengths()
    expect(queueLengths[0]).eq(0) // increasePositionRequestKeysStart
    expect(queueLengths[1]).eq(1) // increasePositionRequestKeys.length
    expect(queueLengths[2]).eq(0) // decreasePositionRequestKeysStart
    expect(queueLengths[3]).eq(0) // decreasePositionRequestKeys.length

    await dai.mint(user1.address, expandDecimals(600, 18))
    await dai.connect(user1).approve(router.address, expandDecimals(600, 18))
    await router.connect(user1).approvePlugin(positionRouter.address)

    await positionRouter.connect(user1).createIncreasePosition(...params.concat([4000, referralCode]), { value: 4000 })

    expect(await provider.getBalance(positionRouter.address)).eq(0)
    expect(await bnb.balanceOf(positionRouter.address)).eq(4000)
    expect(await dai.balanceOf(positionRouter.address)).eq(expandDecimals(600, 18))
    expect(await dai.balanceOf(user1.address)).eq(0)

    key = await positionRouter.getRequestKey(user1.address, 1)
    request = await positionRouter.increasePositionRequests(key)
    expect(request.account).eq(user1.address)

    await positionRouter.connect(positionKeeper).cancelIncreasePosition(key, executionFeeReceiver.address)
    request = await positionRouter.increasePositionRequests(key)
    expect(request.account).eq(user1.address)

    await mineBlock(provider)
    await mineBlock(provider)
    await mineBlock(provider)

    const tx2 = await positionRouter.connect(positionKeeper).cancelIncreasePosition(key, executionFeeReceiver.address)
    await reportGasUsed(provider, tx2, "cancelIncreasePosition gas used")

    request = await positionRouter.increasePositionRequests(key)
    expect(request.account).eq(AddressZero)

    expect(await provider.getBalance(positionRouter.address)).eq(0)
    expect(await bnb.balanceOf(positionRouter.address)).eq(0)
    expect(await dai.balanceOf(positionRouter.address)).eq(0)
    expect(await dai.balanceOf(user1.address)).eq(expandDecimals(600, 18))

    expect(await provider.getBalance(executionFeeReceiver.address)).eq(8000)

    await dai.mint(user2.address, expandDecimals(600, 18))
    await dai.connect(user2).approve(router.address, expandDecimals(600, 18))
    await router.connect(user2).approvePlugin(positionRouter.address)

    params[0] = [dai.address] // _path
    params[5] = false // _isLong

    const tx3 = await positionRouter.connect(user2).createIncreasePosition(...params.concat([4000, referralCode]), { value: 4000 })
    await reportGasUsed(provider, tx3, "createIncreasePosition gas used")

    key = await positionRouter.getRequestKey(user2.address, 1)

    await mineBlock(provider)
    await mineBlock(provider)

    await dai.mint(vault.address, expandDecimals(7000, 18))
    await vault.buyUSDG(dai.address, user1.address)

    const tx4 = await positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address)
    await reportGasUsed(provider, tx4, "executeIncreasePosition gas used")

    request = await positionRouter.increasePositionRequests(key)
    expect(request.account).eq(AddressZero)

    position = await vault.getPosition(user2.address, dai.address, bnb.address, false)
    expect(position[0]).eq(toUsd(6000)) // size
    expect(position[1]).eq("594000000000000000000000000000000") // collateral, 594
    expect(position[2]).eq(toUsd(300)) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq(expandDecimals(6000, 18)) // reserveAmount
    expect(position[5]).eq(0) // realisedPnl
    expect(position[6]).eq(true) // hasProfit

    queueLengths = await positionRouter.getRequestQueueLengths()
    expect(queueLengths[0]).eq(0) // increasePositionRequestKeysStart
    expect(queueLengths[1]).eq(3) // increasePositionRequestKeys.length
    expect(queueLengths[2]).eq(0) // decreasePositionRequestKeysStart
    expect(queueLengths[3]).eq(0) // decreasePositionRequestKeys.length
  })

  it("createIncreasePositionETH, executeIncreasePosition, cancelIncreasePosition", async () => {
    const referralCode = "0x0000000000000000000000000000000000000000000000000000000000000123"

    const params = [
      [dai.address, bnb.address], // _path
      bnb.address, // _indexToken
      expandDecimals(290, 18), // _minOut
      toUsd(6000), // _sizeDelta
      false, // _isLong
      toUsd(300), // _acceptablePrice
    ]

    await expect(positionRouter.connect(user0).createIncreasePositionETH(...params.concat([3000, referralCode])))
      .to.be.revertedWith("PositionRouter: invalid executionFee")

    await expect(positionRouter.connect(user0).createIncreasePositionETH(...params.concat([4000, referralCode])), { value: 3000 })
      .to.be.revertedWith("PositionRouter: invalid msg.value")

    await expect(positionRouter.connect(user0).createIncreasePositionETH(...params.concat([4000, referralCode]), { value: 4000 }))
      .to.be.revertedWith("PositionRouter: invalid _path")

    params[0] = []
    await expect(positionRouter.connect(user0).createIncreasePositionETH(...params.concat([4000, referralCode]), { value: 4000 }))
      .to.be.revertedWith("PositionRouter: invalid _path length")

    params[0] = [bnb.address, dai.address, dai.address]
    await expect(positionRouter.connect(user0).createIncreasePositionETH(...params.concat([4000, referralCode]), { value: 4000 }))
      .to.be.revertedWith("PositionRouter: invalid _path length")

    params[0] = [bnb.address, dai.address]

    key = await positionRouter.getRequestKey(user0.address, 1)
    let request = await positionRouter.increasePositionRequests(key)

    expect(await referralStorage.traderReferralCodes(user0.address)).eq(HashZero)
    expect(await bnb.balanceOf(positionRouter.address)).eq(0)
    expect(await positionRouter.increasePositionsIndex(user0.address)).eq(0)

    expect(request.account).eq(AddressZero)
    expect(request.path).eq(undefined)
    expect(request.indexToken).eq(AddressZero)
    expect(request.amountIn).eq(0)
    expect(request.minOut).eq(0)
    expect(request.sizeDelta).eq(0)
    expect(request.isLong).eq(false)
    expect(request.acceptablePrice).eq(0)
    expect(request.executionFee).eq(0)
    expect(request.blockNumber).eq(0)
    expect(request.blockTime).eq(0)
    expect(request.hasCollateralInETH).eq(false)

    let queueLengths = await positionRouter.getRequestQueueLengths()
    expect(queueLengths[0]).eq(0) // increasePositionRequestKeysStart
    expect(queueLengths[1]).eq(0) // increasePositionRequestKeys.length
    expect(queueLengths[2]).eq(0) // decreasePositionRequestKeysStart
    expect(queueLengths[3]).eq(0) // decreasePositionRequestKeys.length

    expect(await provider.getBalance(positionRouter.address)).eq(0)
    expect(await bnb.balanceOf(positionRouter.address)).eq(0)
    expect(await dai.balanceOf(positionRouter.address)).eq(0)

    const tx = await positionRouter.connect(user0).createIncreasePositionETH(...params.concat([4000, referralCode]), { value: expandDecimals(1, 18).add(4000) })
    await reportGasUsed(provider, tx, "createIncreasePositionETH gas used")

    expect(await provider.getBalance(positionRouter.address)).eq(0)
    expect(await bnb.balanceOf(positionRouter.address)).eq(expandDecimals(1, 18).add(4000))
    expect(await dai.balanceOf(positionRouter.address)).eq(0)

    const blockNumber = await provider.getBlockNumber()
    const blockTime = await getBlockTime(provider)

    request = await positionRouter.increasePositionRequests(key)

    expect(await referralStorage.traderReferralCodes(user0.address)).eq(referralCode)
    expect(await bnb.balanceOf(positionRouter.address)).eq(expandDecimals(1, 18).add(4000))
    expect(await positionRouter.increasePositionsIndex(user0.address)).eq(1)

    expect(request.account).eq(user0.address)
    expect(request.path).eq(undefined)
    expect(request.indexToken).eq(bnb.address)
    expect(request.amountIn).eq(expandDecimals(1, 18))
    expect(request.minOut).eq(expandDecimals(290, 18))
    expect(request.sizeDelta).eq(toUsd(6000))
    expect(request.isLong).eq(false)
    expect(request.acceptablePrice).eq(toUsd(300))
    expect(request.executionFee).eq(4000)
    expect(request.blockNumber).eq(blockNumber)
    expect(request.blockTime).eq(blockTime)
    expect(request.hasCollateralInETH).eq(true)

    queueLengths = await positionRouter.getRequestQueueLengths()
    expect(queueLengths[0]).eq(0) // increasePositionRequestKeysStart
    expect(queueLengths[1]).eq(1) // increasePositionRequestKeys.length
    expect(queueLengths[2]).eq(0) // decreasePositionRequestKeysStart
    expect(queueLengths[3]).eq(0) // decreasePositionRequestKeys.length

    await positionRouter.setDelayValues(5, 300, 500)

    const executionFeeReceiver = newWallet()
    await expect(positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address))
      .to.be.revertedWith("PositionRouter: forbidden")

    await positionRouter.setPositionKeeper(positionKeeper.address, true)

    // executeIncreasePosition will return without error and without executing the position if the minBlockDelayKeeper has not yet passed
    await positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address)

    request = await positionRouter.increasePositionRequests(key)
    expect(request.account).eq(user0.address)

    await mineBlock(provider)

    await expect(positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address))
      .to.be.revertedWith("Vault: poolAmount exceeded")

    await dai.mint(vault.address, expandDecimals(7000, 18))
    await vault.buyUSDG(dai.address, user1.address)

    await expect(positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address))
      .to.be.revertedWith("Timelock: forbidden")

    await timelock.setContractHandler(positionRouter.address, true)

    await expect(positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address))
      .to.be.revertedWith("Router: invalid plugin")

    await router.addPlugin(positionRouter.address)

    await expect(positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address))
      .to.be.revertedWith("Router: plugin not approved")

    await router.connect(user0).approvePlugin(positionRouter.address)

    await expect(positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address))
      .to.be.revertedWith("Vault: leverage not enabled")

    await timelock.setShouldToggleIsLeverageEnabled(true)

    let position = await vault.getPosition(user0.address, bnb.address, bnb.address, true)
    expect(position[0]).eq(0) // size
    expect(position[1]).eq(0) // collateral
    expect(position[2]).eq(0) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq(0) // reserveAmount
    expect(position[5]).eq(0) // realisedPnl
    expect(position[6]).eq(true) // hasProfit
    expect(position[7]).eq(0) // lastIncreasedTime

    expect(await provider.getBalance(executionFeeReceiver.address)).eq(0)

    const tx1 = await positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address)
    await reportGasUsed(provider, tx1, "executeIncreasePosition gas used")

    expect(await provider.getBalance(positionRouter.address)).eq(0)
    expect(await bnb.balanceOf(positionRouter.address)).eq(0)
    expect(await dai.balanceOf(positionRouter.address)).eq(0)

    request = await positionRouter.increasePositionRequests(key)

    expect(request.account).eq(AddressZero)
    expect(request.path).eq(undefined)
    expect(request.indexToken).eq(AddressZero)
    expect(request.amountIn).eq(0)
    expect(request.minOut).eq(0)
    expect(request.sizeDelta).eq(0)
    expect(request.isLong).eq(false)
    expect(request.acceptablePrice).eq(0)
    expect(request.executionFee).eq(0)
    expect(request.blockNumber).eq(0)
    expect(request.blockTime).eq(0)
    expect(request.hasCollateralInETH).eq(false)

    position = await vault.getPosition(user0.address, dai.address, bnb.address, false)
    expect(position[0]).eq(toUsd(6000)) // size
    expect(position[1]).eq("293100000000000000000000000000000") // collateral, 293.1
    expect(position[2]).eq(toUsd(300)) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq(expandDecimals(6000, 18)) // reserveAmount
    expect(position[5]).eq(0) // realisedPnl
    expect(position[6]).eq(true) // hasProfit

    expect(await provider.getBalance(executionFeeReceiver.address)).eq(4000)

    queueLengths = await positionRouter.getRequestQueueLengths()
    expect(queueLengths[0]).eq(0) // increasePositionRequestKeysStart
    expect(queueLengths[1]).eq(1) // increasePositionRequestKeys.length
    expect(queueLengths[2]).eq(0) // decreasePositionRequestKeysStart
    expect(queueLengths[3]).eq(0) // decreasePositionRequestKeys.length

    await router.connect(user1).approvePlugin(positionRouter.address)
    await positionRouter.connect(user1).createIncreasePositionETH(...params.concat([4000, referralCode]), { value: expandDecimals(1, 18).add(4000) })

    expect(await provider.getBalance(positionRouter.address)).eq(0)
    expect(await bnb.balanceOf(positionRouter.address)).eq(expandDecimals(1, 18).add(4000))
    expect(await dai.balanceOf(positionRouter.address)).eq(0)
    expect(await dai.balanceOf(user1.address)).eq(0)

    key = await positionRouter.getRequestKey(user1.address, 1)
    request = await positionRouter.increasePositionRequests(key)
    expect(request.account).eq(user1.address)

    await positionRouter.connect(positionKeeper).cancelIncreasePosition(key, executionFeeReceiver.address)
    request = await positionRouter.increasePositionRequests(key)
    expect(request.account).eq(user1.address)

    await mineBlock(provider)
    await mineBlock(provider)
    await mineBlock(provider)

    const balanceBefore = await provider.getBalance(user1.address)
    const tx2 = await positionRouter.connect(positionKeeper).cancelIncreasePosition(key, executionFeeReceiver.address)
    await reportGasUsed(provider, tx2, "cancelIncreasePosition gas used")

    request = await positionRouter.increasePositionRequests(key)
    expect(request.account).eq(AddressZero)

    expect(await provider.getBalance(positionRouter.address)).eq(0)
    expect((await provider.getBalance(user1.address)).sub(balanceBefore)).eq(expandDecimals(1, 18))
    expect(await bnb.balanceOf(positionRouter.address)).eq(0)
    expect(await dai.balanceOf(positionRouter.address)).eq(0)
    expect(await dai.balanceOf(user1.address)).eq(0)

    expect(await provider.getBalance(executionFeeReceiver.address)).eq(8000)

    await router.connect(user2).approvePlugin(positionRouter.address)

    params[0] = [bnb.address] // _path
    params[4] = true // _isLong

    const tx3 = await positionRouter.connect(user2).createIncreasePositionETH(...params.concat([4000, referralCode]), { value: expandDecimals(1, 18).add(4000) })
    await reportGasUsed(provider, tx3, "createIncreasePosition gas used")

    key = await positionRouter.getRequestKey(user2.address, 1)

    await mineBlock(provider)
    await mineBlock(provider)

    await bnb.mint(vault.address, expandDecimals(25, 18))
    await vault.buyUSDG(bnb.address, user1.address)

    const tx4 = await positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address)
    await reportGasUsed(provider, tx4, "executeIncreasePosition gas used")

    request = await positionRouter.increasePositionRequests(key)
    expect(request.account).eq(AddressZero)

    position = await vault.getPosition(user2.address, bnb.address, bnb.address, true)
    expect(position[0]).eq(toUsd(6000)) // size
    expect(position[1]).eq("294000000000000000000000000000000") // collateral, 294
    expect(position[2]).eq(toUsd(300)) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq(expandDecimals(20, 18)) // reserveAmount
    expect(position[5]).eq(0) // realisedPnl
    expect(position[6]).eq(true) // hasProfit

    queueLengths = await positionRouter.getRequestQueueLengths()
    expect(queueLengths[0]).eq(0) // increasePositionRequestKeysStart
    expect(queueLengths[1]).eq(3) // increasePositionRequestKeys.length
    expect(queueLengths[2]).eq(0) // decreasePositionRequestKeysStart
    expect(queueLengths[3]).eq(0) // decreasePositionRequestKeys.length
  })

  it("createIncreasePosition, createDecreasePosition, executeDecreasePosition, cancelDecreasePosition", async () => {
    const referralCode = "0x0000000000000000000000000000000000000000000000000000000000000123"

    const params = [
      [dai.address, bnb.address], // _path
      bnb.address, // _indexToken
      expandDecimals(600, 18), // _amountIn
      expandDecimals(1, 18), // _minOut
      toUsd(6000), // _sizeDelta
      true, // _isLong
      toUsd(300), // _acceptablePrice
    ]

    await router.addPlugin(positionRouter.address)
    await router.connect(user0).approvePlugin(positionRouter.address)

    await dai.mint(user0.address, expandDecimals(600, 18))
    await dai.connect(user0).approve(router.address, expandDecimals(600, 18))

    let key = await positionRouter.getRequestKey(user0.address, 1)
    let request = await positionRouter.increasePositionRequests(key)

    expect(await referralStorage.traderReferralCodes(user0.address)).eq(HashZero)
    expect(await dai.balanceOf(positionRouter.address)).eq(0)
    expect(await positionRouter.increasePositionsIndex(user0.address)).eq(0)

    expect(request.account).eq(AddressZero)
    expect(request.path).eq(undefined)
    expect(request.indexToken).eq(AddressZero)
    expect(request.amountIn).eq(0)
    expect(request.minOut).eq(0)
    expect(request.sizeDelta).eq(0)
    expect(request.isLong).eq(false)
    expect(request.acceptablePrice).eq(0)
    expect(request.executionFee).eq(0)
    expect(request.blockNumber).eq(0)
    expect(request.blockTime).eq(0)
    expect(request.hasCollateralInETH).eq(false)

    let queueLengths = await positionRouter.getRequestQueueLengths()
    expect(queueLengths[0]).eq(0) // increasePositionRequestKeysStart
    expect(queueLengths[1]).eq(0) // increasePositionRequestKeys.length
    expect(queueLengths[2]).eq(0) // decreasePositionRequestKeysStart
    expect(queueLengths[3]).eq(0) // decreasePositionRequestKeys.length

    expect(await provider.getBalance(positionRouter.address)).eq(0)
    expect(await bnb.balanceOf(positionRouter.address)).eq(0)
    expect(await dai.balanceOf(positionRouter.address)).eq(0)

    const tx0 = await positionRouter.connect(user0).createIncreasePosition(...params.concat([4000, referralCode]), { value: 4000 })
    await reportGasUsed(provider, tx0, "createIncreasePosition gas used")

    expect(await provider.getBalance(positionRouter.address)).eq(0)
    expect(await bnb.balanceOf(positionRouter.address)).eq(4000)
    expect(await dai.balanceOf(positionRouter.address)).eq(expandDecimals(600, 18))

    let blockNumber = await provider.getBlockNumber()
    let blockTime = await getBlockTime(provider)

    request = await positionRouter.increasePositionRequests(key)

    expect(await referralStorage.traderReferralCodes(user0.address)).eq(referralCode)
    expect(await dai.balanceOf(positionRouter.address)).eq(expandDecimals(600, 18))
    expect(await positionRouter.increasePositionsIndex(user0.address)).eq(1)

    expect(request.account).eq(user0.address)
    expect(request.path).eq(undefined)
    expect(request.indexToken).eq(bnb.address)
    expect(request.amountIn).eq(expandDecimals(600, 18))
    expect(request.minOut).eq(expandDecimals(1, 18))
    expect(request.sizeDelta).eq(toUsd(6000))
    expect(request.isLong).eq(true)
    expect(request.acceptablePrice).eq(toUsd(300))
    expect(request.executionFee).eq(4000)
    expect(request.blockNumber).eq(blockNumber)
    expect(request.blockTime).eq(blockTime)
    expect(request.hasCollateralInETH).eq(false)

    queueLengths = await positionRouter.getRequestQueueLengths()
    expect(queueLengths[0]).eq(0) // increasePositionRequestKeysStart
    expect(queueLengths[1]).eq(1) // increasePositionRequestKeys.length
    expect(queueLengths[2]).eq(0) // decreasePositionRequestKeysStart
    expect(queueLengths[3]).eq(0) // decreasePositionRequestKeys.length

    await positionRouter.setDelayValues(5, 300, 500)

    const executionFeeReceiver = newWallet()
    await positionRouter.setPositionKeeper(positionKeeper.address, true)

    // executeIncreasePosition will return without error and without executing the position if the minBlockDelayKeeper has not yet passed
    await positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address)

    request = await positionRouter.increasePositionRequests(key)
    expect(request.account).eq(user0.address)

    await mineBlock(provider)

    await bnb.mint(vault.address, expandDecimals(30, 18))
    await vault.buyUSDG(bnb.address, user1.address)

    await timelock.setContractHandler(positionRouter.address, true)

    await timelock.setShouldToggleIsLeverageEnabled(true)

    let position = await vault.getPosition(user0.address, bnb.address, bnb.address, true)
    expect(position[0]).eq(0) // size
    expect(position[1]).eq(0) // collateral
    expect(position[2]).eq(0) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq(0) // reserveAmount
    expect(position[5]).eq(0) // realisedPnl
    expect(position[6]).eq(true) // hasProfit
    expect(position[7]).eq(0) // lastIncreasedTime

    expect(await provider.getBalance(executionFeeReceiver.address)).eq(0)

    const tx1 = await positionRouter.connect(positionKeeper).executeIncreasePosition(key, executionFeeReceiver.address)
    await reportGasUsed(provider, tx1, "executeIncreasePosition gas used")

    expect(await provider.getBalance(positionRouter.address)).eq(0)
    expect(await bnb.balanceOf(positionRouter.address)).eq(0)
    expect(await dai.balanceOf(positionRouter.address)).eq(0)

    request = await positionRouter.increasePositionRequests(key)

    expect(request.account).eq(AddressZero)
    expect(request.path).eq(undefined)
    expect(request.indexToken).eq(AddressZero)
    expect(request.amountIn).eq(0)
    expect(request.minOut).eq(0)
    expect(request.sizeDelta).eq(0)
    expect(request.isLong).eq(false)
    expect(request.acceptablePrice).eq(0)
    expect(request.executionFee).eq(0)
    expect(request.blockNumber).eq(0)
    expect(request.blockTime).eq(0)
    expect(request.hasCollateralInETH).eq(false)

    position = await vault.getPosition(user0.address, bnb.address, bnb.address, true)
    expect(position[0]).eq(toUsd(6000)) // size
    expect(position[1]).eq("592200000000000000000000000000000") // collateral, 592.2
    expect(position[2]).eq(toUsd(300)) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq(expandDecimals(20, 18)) // reserveAmount
    expect(position[5]).eq(0) // realisedPnl
    expect(position[6]).eq(true) // hasProfit

    expect(await provider.getBalance(executionFeeReceiver.address)).eq(4000)

    queueLengths = await positionRouter.getRequestQueueLengths()
    expect(queueLengths[0]).eq(0) // increasePositionRequestKeysStart
    expect(queueLengths[1]).eq(1) // increasePositionRequestKeys.length
    expect(queueLengths[2]).eq(0) // decreasePositionRequestKeysStart
    expect(queueLengths[3]).eq(0) // decreasePositionRequestKeys.length

    let decreasePositionParams = [
      bnb.address, // _collateralToken
      bnb.address, // _indexToken
      toUsd(300), // _collateralDelta
      toUsd(1000), // _sizeDelta
      true, // _isLong
      user1.address,  // _receiver
      toUsd(290)  // _acceptablePrice
    ]

    await expect(positionRouter.connect(user0).createDecreasePosition(...decreasePositionParams.concat([3000, false])))
      .to.be.revertedWith("PositionRouter: invalid executionFee")

    await expect(positionRouter.connect(user0).createDecreasePosition(...decreasePositionParams.concat([4000, false])))
      .to.be.revertedWith("PositionRouter: invalid msg.value")

    await expect(positionRouter.connect(user0).createDecreasePosition(...decreasePositionParams.concat([4000, false]), { value: 3000 }))
      .to.be.revertedWith("PositionRouter: invalid msg.value")

    await expect(positionRouter.connect(user0).createDecreasePosition(...decreasePositionParams.concat([4000, false]), { value: 3000 }))
      .to.be.revertedWith("PositionRouter: invalid msg.value")

    decreasePositionParams[0] = dai.address

    await expect(positionRouter.connect(user0).createDecreasePosition(...decreasePositionParams.concat([4000, true]), { value: 4000 }))
      .to.be.revertedWith("PositionRouter: invalid _collateralToken")

    decreasePositionParams[0] = bnb.address

    const tx2 = await positionRouter.connect(user0).createDecreasePosition(...decreasePositionParams.concat([4000, false]), { value: 4000 })
    await reportGasUsed(provider, tx2, "createDecreasePosition gas used")

    blockNumber = await provider.getBlockNumber()
    blockTime = await getBlockTime(provider)

    key = await positionRouter.getRequestKey(user0.address, 1)
    request = await positionRouter.decreasePositionRequests(key)

    expect(request.account).eq(user0.address)
    expect(request.collateralToken).eq(bnb.address)
    expect(request.indexToken).eq(bnb.address)
    expect(request.collateralDelta).eq(toUsd(300))
    expect(request.sizeDelta).eq(toUsd(1000))
    expect(request.isLong).eq(true)
    expect(request.receiver).eq(user1.address)
    expect(request.acceptablePrice).eq(toUsd(290))
    expect(request.blockNumber).eq(blockNumber)
    expect(request.blockTime).eq(blockTime)
    expect(request.withdrawETH).eq(false)
  })
})
