# arc-bridge

Minimal open-source self-custody flow for USDC:

`Base wallet → approve → GatewayWallet.deposit → Gateway finality → estimate → EIP-712 → forwarded transfer → Arc`

## Included

- `web/` — a simple self-custody deposit page. Users connect their own wallet, click `Approve`, then `Deposit`.
- `bridge.js` — CLI for checking deposits, waiting for Gateway credit, and submitting a forwarded transfer.
- Private keys are never stored or sent to a server.
- Forwarded transfers do not require USDC on Arc for destination gas; Circle submits the mint transaction.

## Web deposit

Run the page through an HTTP server (wallets commonly block `file://` pages):

```bash
cd ~/Desktop/arc-bridge
npm install
npm run web
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080) or [http://localhost:8080](http://localhost:8080), connect a wallet on Base, and:

1. Click `Approve USDC` to approve the exact amount.
2. Click `Deposit to Gateway` to call `GatewayWallet.deposit(USDC, amount)`.

If port `8080` is already in use:

```bash
PORT=8081 npm run web
```

Then open [http://127.0.0.1:8081](http://127.0.0.1:8081).

After the deposit, Gateway waits for Base finality. Base deposits commonly take about 13–19 minutes. Never send USDC with a normal ERC-20 `transfer` directly to GatewayWallet; that does not create a Gateway balance.

After merging the GitHub Pages workflow, the page will be available at:
`https://0xkayser.github.io/arc-bridge/`.

## CLI

```bash
npm install

# Read-only diagnostics
PRIVATE_KEY=0x... node bridge.js balance
PRIVATE_KEY=0x... node bridge.js diagnose

# 1. Approve (if allowance is insufficient) + deposit on Base
PRIVATE_KEY=0x... node bridge.js deposit 25

# 2. Wait until Gateway sees the deposit
PRIVATE_KEY=0x... node bridge.js wait 25

# 3. Estimate → sign burn intent → forwarded transfer → poll status
PRIVATE_KEY=0x... node bridge.js transfer 25
```

Add `--yes` to skip interactive confirmation for on-chain transactions:

```bash
PRIVATE_KEY=0x... node bridge.js deposit 25 --yes
PRIVATE_KEY=0x... node bridge.js transfer 25 --yes
```

The CLI never hand-sizes `MAX_FEE`: `maxFee` and `maxBlockHeight` come from `/v1/estimate?enableForwarder=true`. `destinationToken` is not guessed; the code reads it from Gateway API and stops before signing if the API does not publish an active destination token.

## Current limitation

At the latest check, Circle's live mainnet Gateway API did not list Arc mainnet domain `26` in `/v1/info`. Base deposits can still be made, but the CLI will refuse to sign or submit a transfer until Circle activates Arc mainnet. Arc Testnet and Arc mainnet use different Gateway API environments and contract addresses.

## Base mainnet contracts

- GatewayWallet: `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`
- Base USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- GatewayMinter: `0x2222222d7164433c4C09B0b0D809a9b52C04C205`
- Gateway API: `https://gateway-api.circle.com/v1`

## License

MIT. See [LICENSE](./LICENSE).
