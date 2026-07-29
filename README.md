# arc-bridge

Minimal open-source self-custody flow for USDC:

`Base wallet → approve → GatewayWallet.deposit → Gateway finality → estimate → EIP-712 → self-mint → Arc`

## Included

- `web/` — a simple self-custody deposit page. Users connect their own wallet, click `Approve`, then `Deposit`.
- `bridge.js` — Node/viem CLI for deposit diagnostics and the legacy forwarded-transfer path.
- `arc_gateway_bridge.py` — recommended mainnet CLI: automatic Gateway polling, real fee estimation, EIP-712 signing, Circle attestation, and Arc self-mint.
- Private keys are never stored or sent to a server.
- The Python CLI uses self-mint by default because the Circle Forwarder may be temporarily unavailable. It requires USDC on Arc for gas.

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

## Mainnet Python CLI (recommended)

This is the shortest working path for Base → Arc mainnet. It uses Circle's mainnet API feature header, calls `/estimate` for the real fee and expiry, converts the canonical response to the required `bytes32` fields, and saves any returned attestation locally with restrictive permissions.

Install in an isolated environment:

```bash
cd ~/Desktop/arc-bridge
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Set the key only in your local shell. Never commit it or paste it into chat:

```bash
read -s "PRIVKEY?Private key: "; echo
export PRIVKEY
python arc_gateway_bridge.py balance
```

Confirm that `balance` shows your own address and the expected Gateway balance, then bridge:

```bash
python arc_gateway_bridge.py bridge --amount 100 --yes
unset PRIVKEY
```

The command waits for Gateway credit, estimates the live fee, adjusts the amount to leave the fee, requests the attestation, and calls `gatewayMint` on Arc. `--yes` is required because it signs a burn intent and sends a mint transaction. If you do not have Arc USDC for gas, use `--calldata` with `--yes` and give the printed call data to a trusted relayer.

The script writes only the short-lived attestation state to `arc_gateway_state.json`; the file is ignored by Git and created with mode `600`. It never writes the private key.

## Node CLI

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

The Node CLI is retained for deposit diagnostics and forwarded transfers. For the currently working Arc mainnet path, use the Python CLI above. The Gateway API requires the `X-ARC-PRIVATE-MAINNET-ENABLED: true` header for Arc mainnet to appear in `/v1/info` and to accept the estimate/attestation requests.

## Base mainnet contracts

- GatewayWallet: `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`
- Base USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- GatewayMinter: `0x2222222d7164433c4C09B0b0D809a9b52C04C205`
- Arc USDC / native gas: `0x3600000000000000000000000000000000000000`
- Gateway API: `https://gateway-api.circle.com/v1`

## License

MIT. See [LICENSE](./LICENSE).
