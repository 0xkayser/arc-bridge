const BASE_CHAIN_ID = "0x2105";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const GATEWAY_WALLET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
const BASESCAN = "https://basescan.org/tx/";

const $ = (id) => document.getElementById(id);
const connectButton = $("connect");
const approveButton = $("approve");
const depositButton = $("deposit");
const amountInput = $("amount");
const walletLabel = $("wallet");
const statusLabel = $("status");

let account;

function setStatus(message, error = false) {
  statusLabel.textContent = message;
  statusLabel.style.color = error ? "#ffb4b4" : "#cbd5f5";
}

function requireProvider() {
  if (!window.ethereum) {
    throw new Error("No EVM wallet found. Install MetaMask or another browser wallet.");
  }
  return window.ethereum;
}

function strip0x(value) {
  return value.replace(/^0x/, "");
}

function word(value) {
  return strip0x(value).toLowerCase().padStart(64, "0");
}

function parseUsdc(value) {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(normalized)) {
    throw new Error("Enter a positive USDC amount with up to 6 decimals.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
  if (units <= 0n) throw new Error("Amount must be greater than zero.");
  return units;
}

function amountHex(units) {
  return units.toString(16).padStart(64, "0");
}

function encodeApprove(spender, units) {
  return `0x095ea7b3${word(spender)}${amountHex(units)}`;
}

function encodeDeposit(token, units) {
  return `0x47e7ef24${word(token)}${amountHex(units)}`;
}

function encodeBalanceOf(owner) {
  return `0x70a08231${word(owner)}`;
}

function encodeAllowance(owner, spender) {
  return `0xdd62ed3e${word(owner)}${word(spender)}`;
}

async function rpc(method, params = []) {
  return requireProvider().request({ method, params });
}

async function switchToBase() {
  const chainId = await rpc("eth_chainId");
  if (chainId.toLowerCase() === BASE_CHAIN_ID) return;
  try {
    await rpc("wallet_switchEthereumChain", [{ chainId: BASE_CHAIN_ID }]);
  } catch (error) {
    if (error.code !== 4902) throw error;
    await rpc("wallet_addEthereumChain", [{
      chainId: BASE_CHAIN_ID,
      chainName: "Base",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://mainnet.base.org"],
      blockExplorerUrls: ["https://basescan.org"],
    }]);
  }
}

async function waitForReceipt(hash) {
  for (;;) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`Transaction reverted: ${hash}`);
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function send(data) {
  const hash = await rpc("eth_sendTransaction", [{
    from: account,
    to: data.to,
    data: data.data,
    value: "0x0",
  }]);
  setStatus(`Waiting for confirmation…\n${BASESCAN}${hash}`);
  await waitForReceipt(hash);
  return hash;
}

async function readUint256(data) {
  const result = await rpc("eth_call", [{ to: data.to, data: data.data }, "latest"]);
  return BigInt(result);
}

async function refresh() {
  if (!account) return;
  const [balance, allowance] = await Promise.all([
    readUint256({ to: BASE_USDC, data: encodeBalanceOf(account) }),
    readUint256({ to: BASE_USDC, data: encodeAllowance(account, GATEWAY_WALLET) }),
  ]);
  walletLabel.textContent = `${account} · wallet ${formatUnits(balance)} USDC · allowance ${formatUnits(allowance)} USDC`;
}

function formatUnits(units) {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function connect() {
  await switchToBase();
  const accounts = await rpc("eth_requestAccounts");
  if (!accounts[0]) throw new Error("No wallet account selected.");
  account = accounts[0];
  connectButton.textContent = "Connected";
  await refresh();
  setStatus("Ready. Approve the amount, then deposit it into Gateway.");
}

async function approve() {
  if (!account) await connect();
  const units = parseUsdc(amountInput.value);
  setStatus("Approve is waiting for your wallet…");
  const hash = await send({ to: BASE_USDC, data: encodeApprove(GATEWAY_WALLET, units) });
  await refresh();
  setStatus(`Approval confirmed.\n${BASESCAN}${hash}`);
}

async function deposit() {
  if (!account) await connect();
  const units = parseUsdc(amountInput.value);
  const allowance = await readUint256({
    to: BASE_USDC,
    data: encodeAllowance(account, GATEWAY_WALLET),
  });
  if (allowance < units) {
    throw new Error("Allowance is too low. Click Approve first.");
  }
  setStatus("Deposit is waiting for your wallet…");
  const hash = await send({ to: GATEWAY_WALLET, data: encodeDeposit(BASE_USDC, units) });
  await refresh();
  setStatus(
    `Deposit confirmed on Base. Gateway balance appears after finality (about 13–19 minutes).\n${BASESCAN}${hash}`,
  );
}

async function run(action) {
  approveButton.disabled = true;
  depositButton.disabled = true;
  try {
    await action();
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    approveButton.disabled = false;
    depositButton.disabled = false;
  }
}

connectButton.addEventListener("click", () => run(connect));
approveButton.addEventListener("click", () => run(approve));
depositButton.addEventListener("click", () => run(deposit));

if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", (accounts) => {
    account = accounts[0];
    if (account) refresh().catch((error) => setStatus(error.message, true));
  });
  window.ethereum.on?.("chainChanged", () => window.location.reload());
}
