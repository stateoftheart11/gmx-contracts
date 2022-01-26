const { deployContract, contractAt , sendTxn, writeTmpAddresses, callWithRetries } = require("../shared/helpers")
const { expandDecimals } = require("../../test/shared/utilities")
const { toUsd } = require("../../test/shared/units")

const network = (process.env.HARDHAT_NETWORK || 'mainnet');
const tokens = require('./tokens')[network];

async function main() {
  const frame = new ethers.providers.JsonRpcProvider("http://127.0.0.1:1248")
  const signer = frame.getSigner()
  let vault
  if (network === "avax") {
    vault = await contractAt("Vault", "0x9ab2De34A33fB459b538c43f251eB825645e8595")
  }
  if (network === "arbitrum") {
    vault = await contractAt("Vault", "0x489ee077994B6658eAfA855C308275EAd8097C4A")
  }

  const timelock = await contractAt("Timelock", await vault.gov(), signer)
  console.log("timelock", timelock.address)

  await sendTxn(timelock.setFees(
    vault.address,
    50, // _taxBasisPoints
    5, // _stableTaxBasisPoints
    25, // _mintBurnFeeBasisPoints
    25, // _swapFeeBasisPoints
    1, // _stableSwapFeeBasisPoints
    10, // _marginFeeBasisPoints
    toUsd(5), // _liquidationFeeUsd
    12 * 60 * 60, // _minProfitTime
    true // _hasDynamicFees
  ), "vault.setFees")
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
