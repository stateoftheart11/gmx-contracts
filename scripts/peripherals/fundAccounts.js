const network = (process.env.HARDHAT_NETWORK || 'mainnet');

function getArbTransfers() {
  return [
    {
      address: "0x67F1B9E91D7bB46556ba013c1B187C461e2a1Ffd", // price sender
      amount: "5"
    },
    {
      address: "0xd4266F8F82F7405429EE18559e548979D49160F3", // order keeper
      amount: "0.5"
    },
    {
      address: "0x44311c91008DDE73dE521cd25136fD37d616802c", // liquidator
      amount: "2.8"
    }
  ]
}

function getAvaxTransfers() {
  return [
    {
      address: "0xB6A92Ae811B6A3530b4C01a78651ad295D9570d4", // price sender
      amount: "206"
    },
    {
      address: "0x06f34388A7CFDcC68aC9167C5f1C23DD39783179", // order keeper
      amount: "29"
    },
    {
      address: "0x7858A4C42C619a68df6E95DF7235a9Ec6F0308b9", // liquidator
      amount: "42.5"
    }
  ]
}

async function main() {
  const frame = new ethers.providers.JsonRpcProvider("http://127.0.0.1:1248")
  const signer = frame.getSigner()

  let transfers

  if (network === "avax") {
    transfers = getAvaxTransfers()
  }
  if (network === "arbitrum") {
    transfers = getArbTransfers()
  }

  for (let i = 0; i < transfers.length; i++) {
    const transferItem = transfers[i]
    if (parseFloat(transferItem.amount) === 0) {
      continue
    }
    await signer.sendTransaction({
      to: transferItem.address,
      value: ethers.utils.parseEther(transferItem.amount)
    })
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
