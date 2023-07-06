# uniswapV2-buy-flashbots

Buy any token on Uniswap V2 with flashbots feature, meaning bypass mempool pending process.

## Usage

### 1. Create your own environment

Check `.env.sample` file and modify the values you desired. [Read more](#the-values-you-will-modify)

### 2. Install dependencies

Run `yarn` to install dependencies. Main dependencies are `ethers.js` and `@flashbots/ethers-provider-bundle`, which would be necessary part you should know. If you don't know these, please search them online and check their documents.

### 3. Execute the script.

Run `yarn start` to buy the token desired.

## The Values you will modify.

- FLASHBOTS_AUTH_KEY : The bot owner's private key.
- PRIVATE_KEY : Private key of buy transaction's signer wallet. \
  **_(These two variables would be same in most cases.)_**
- RECIPIENT_ADDRESS : Token recipient after buy transation succseed.
- TOKEN_ADDRESS : Token address that you want to buy.
- AMOUNT_IN : WETH amount you wanna swap for the token.

## Warning

Ensure you have enough WETH in your wallet to buy the token, and approved uniswapV2 router to spent your WETH already, before running this script. This is router: `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D`.
