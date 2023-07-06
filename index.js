const { BigNumber, ethers, providers, Wallet } = require("ethers");
const { FlashbotsBundleProvider, FlashbotsBundleResolution } = require("@flashbots/ethers-provider-bundle");
const dotenv = require("dotenv");
const { v4: uuidv4 } = require("uuid");
dotenv.config();

const FLASHBOTS_AUTH_KEY = process.env.FLASHBOTS_AUTH_KEY;

const GWEI = BigNumber.from(10).pow(9);
const PRIORITY_FEE = GWEI.mul(3);
const LEGACY_GAS_PRICE = GWEI.mul(12);
const BLOCKS_IN_THE_FUTURE = 2;

const RouterABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
];
const FactoryABI = ["event PairCreated(address indexed token0, address indexed token1, address pair, uint)"];

const addresses = {
  // WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",   // mainnet
  WETH: "0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6", // goerli
  factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
  router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  recipient: process.env.RECIPIENT_ADDRESS,
};

// Define token address desired to buy
const token0 = process.env.TOKEN_ADDRESS;
const token1 = addresses.WETH;

const CHAIN_ID = process.env.IS_PRODUCTION === "true" ? 1 : 5;
const provider = new providers.WebSocketProvider(CHAIN_ID === 1 ? process.env.NODE_WSS : process.env.NODE_WSS_GOERLI);
const FLASHBOTS_EP = CHAIN_ID === 1 ? "https://relay.flashbots.net/" : "https://relay-goerli.flashbots.net/";

for (const e of ["FLASHBOTS_AUTH_KEY", "PRIVATE_KEY", "TOKEN_ADDRESS"]) {
  if (!process.env[e]) {
    console.warn(`${e} should be defined as an environment variable`);
  }
}

async function main() {
  const authSigner = FLASHBOTS_AUTH_KEY ? new Wallet(FLASHBOTS_AUTH_KEY) : Wallet.createRandom();
  const wallet = new Wallet(process.env.PRIVATE_KEY || "", provider);
  const flashbotsProvider = await FlashbotsBundleProvider.create(provider, authSigner, FLASHBOTS_EP);

  const connectedWallet = wallet.connect(provider);
  const routerInterface = new ethers.utils.Interface(RouterABI);

  const factory = new ethers.Contract(addresses.factory, FactoryABI, connectedWallet);
  const router = new ethers.Contract(addresses.router, RouterABI, connectedWallet);

  let tokenIn, tokenOut;
  if (token0 === addresses.WETH) {
    tokenIn = token0;
    tokenOut = token1;
  }

  if (token1 === addresses.WETH) {
    tokenIn = token1;
    tokenOut = token0;
  }

  if (typeof tokenIn === "undefined") {
    return;
  }
  const amountIn = ethers.utils.parseUnits(process.env.AMOUNT_IN || "0.001", "ether");
  const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
  const amountOutMin = amounts[1].sub(amounts[1].div(10));
  console.log(`
    Buying new token
    =================
    tokenIn: ${amountIn.toString()} ${tokenIn} (WETH)
    tokenOut: ${amountOutMin.toString()} ${tokenOut}
  `);

  const params = [amountIn, amountOutMin, [tokenIn, tokenOut], addresses.recipient, Date.now() + 1000 * 60 * 10];

  const userStats = flashbotsProvider.getUserStats();
  if (process.env.TEST_V2) {
    try {
      const userStats2 = await flashbotsProvider.getUserStatsV2();
      console.log("userStatsV2", userStats2);
    } catch (e) {
      console.error("[v2 error]", e);
    }
  }

  const legacyTransaction = {
    to: addresses.router,
    gasPrice: LEGACY_GAS_PRICE,
    gasLimit: 500000,
    data: routerInterface.encodeFunctionData("swapExactTokensForTokens", params),
    nonce: await provider.getTransactionCount(wallet.address),
    chainId: CHAIN_ID,
  };

  provider.on("block", async (blockNumber) => {
    const block = await provider.getBlock(blockNumber);
    const replacementUuid = uuidv4();

    let eip1559Transaction;
    if (block.baseFeePerGas == null) {
      console.warn("This chain is not EIP-1559 enabled, defaulting to two legacy transactions for demo");
      eip1559Transaction = { ...legacyTransaction };
      // We set a nonce in legacyTransaction above to limit validity to a single landed bundle. Delete that nonce for tx#2, and allow bundle provider to calculate it
      delete eip1559Transaction.nonce;
    } else {
      const maxBaseFeeInFutureBlock = FlashbotsBundleProvider.getMaxBaseFeeInFutureBlock(
        block.baseFeePerGas,
        BLOCKS_IN_THE_FUTURE
      );
      eip1559Transaction = {
        to: addresses.router,
        type: 2,
        maxFeePerGas: PRIORITY_FEE.add(maxBaseFeeInFutureBlock),
        maxPriorityFeePerGas: PRIORITY_FEE,
        gasLimit: 500000,
        data: routerInterface.encodeFunctionData("swapExactTokensForTokens", params),
        chainId: CHAIN_ID,
      };
    }

    const signedTransactions = await flashbotsProvider.signBundle([
      {
        signer: wallet,
        transaction: legacyTransaction,
      },
      {
        signer: wallet,
        transaction: eip1559Transaction,
      },
    ]);
    const targetBlock = blockNumber + BLOCKS_IN_THE_FUTURE;
    const simulation = await flashbotsProvider.simulate(signedTransactions, targetBlock);

    // Using TypeScript discrimination
    if ("error" in simulation) {
      console.warn(`Simulation Error: ${simulation.error.message}`);
      process.exit(1);
    } else {
      console.log(`Simulation Success: ${JSON.stringify(simulation, null, 2)}`);
    }

    const bundleSubmission = await flashbotsProvider.sendRawBundle(signedTransactions, targetBlock, {
      replacementUuid,
    });
    console.log("bundle submitted, waiting");
    if ("error" in bundleSubmission) {
      throw new Error(bundleSubmission.error.message);
    }

    const cancelResult = await flashbotsProvider.cancelBundles(replacementUuid);
    console.log("cancel response", cancelResult);

    const waitResponse = await bundleSubmission.wait();
    console.log(`Wait Response: ${FlashbotsBundleResolution[waitResponse]}`);
    if (
      waitResponse === FlashbotsBundleResolution.BundleIncluded ||
      waitResponse === FlashbotsBundleResolution.AccountNonceTooHigh
    ) {
      process.exit(0);
    } else {
      console.log({
        bundleStats: await flashbotsProvider.getBundleStats(simulation.bundleHash, targetBlock),
        bundleStatsV2:
          process.env.TEST_V2 && (await flashbotsProvider.getBundleStatsV2(simulation.bundleHash, targetBlock)),
        userStats: await userStats,
      });
    }
  });
}

main();
