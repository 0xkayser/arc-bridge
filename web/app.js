const BASE_CHAIN_ID = "0x2105";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const GATEWAY_WALLET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
const GATEWAY_MINTER = "0x2222222d7164433c4C09B0b0D809a9b52C04C205";
const GATEWAY_API = "https://gateway-api.circle.com/v1";
const BASESCAN = "https://basescan.org/tx/";
const ARC_DOMAIN = 26;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const GATEWAY_POLL_MS = 15_000;
const TRANSFER_POLL_MS = 5_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

const $ = (id) => document.getElementById(id);
const connectButton = $("connect");
const approveButton = $("approve");
const depositButton = $("deposit");
const checkGatewayButton = $("check-gateway");
const transferButton = $("transfer");
const amountInput = $("amount");
const walletLabel = $("wallet");
const statusLabel = $("status");
const gatewayStatusLabel = $("gateway-status");

let account;
let gatewayTimer;
let transferReady = false;
let gatewayCheckInProgress = false;

const EIP712_TYPES = {
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
};

function setStatus(message, error = false) {
  statusLabel.textContent = message;
  statusLabel.style.color = error ? "#ffb4b4" : "#cbd5f5";
}

function setGatewayStatus(message, error = false) {
  gatewayStatusLabel.textContent = message;
  gatewayStatusLabel.style.color = error ? "#ffb4b4" : "#aeb9d9";
}

function setTransferReady(ready) {
  transferReady = ready;
  transferButton.disabled = !ready;
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

function toBytes32(address) {
  return `0x${word(address)}`;
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

function randomBytes32() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function rpc(method, params = []) {
  return requireProvider().request({ method, params });
}

async function gatewayRequest(path, body) {
  const response = await fetch(`${GATEWAY_API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!response.ok || json.success === false) {
    throw new Error(`Gateway API ${path}: ${response.status} ${json.message || text}`);
  }
  return json;
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
  const transaction = {
    from: account,
    to: data.to,
    data: data.data,
    value: "0x0",
  };
  // Catch contract reverts before the wallet submits a transaction on-chain.
  await rpc("eth_estimateGas", [transaction]);
  const hash = await rpc("eth_sendTransaction", [transaction]);
  setStatus(`Waiting for confirmation…\n${BASESCAN}${hash}`);
  await waitForReceipt(hash);
  return hash;
}

async function readUint256(data) {
  const result = await rpc("eth_call", [{ to: data.to, data: data.data }, "latest"]);
  return BigInt(result);
}

function formatUnits(units) {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function refresh() {
  if (!account) return;
  const [balance, allowance] = await Promise.all([
    readUint256({ to: BASE_USDC, data: encodeBalanceOf(account) }),
    readUint256({ to: BASE_USDC, data: encodeAllowance(account, GATEWAY_WALLET) }),
  ]);
  walletLabel.textContent = `${account} · wallet ${formatUnits(balance)} USDC · allowance ${formatUnits(allowance)} USDC`;
}

function tokenAddressFromDomainInfo(domainInfo) {
  const candidate =
    domainInfo?.destinationToken ??
    domainInfo?.tokenAddress ??
    domainInfo?.usdc ??
    domainInfo?.tokens?.USDC ??
    domainInfo?.tokens?.find?.((token) => token.symbol === "USDC")?.address;
  return typeof candidate === "string" && /^0x[0-9a-fA-F]{40}$/.test(candidate)
    ? candidate
    : undefined;
}

async function getGatewaySnapshot() {
  const sources = [{ domain: 6, depositor: account }];
  const [balances, deposits, info] = await Promise.all([
    gatewayRequest("/balances", { token: "USDC", sources }),
    gatewayRequest("/deposits", { token: "USDC", sources }),
    gatewayRequest("/info"),
  ]);
  const balanceRow = (balances.balances ?? []).find((row) => Number(row.domain) === 6);
  const arc = (info.domains ?? []).find((row) => Number(row.domain) === ARC_DOMAIN);
  return {
    balance: balanceRow?.balance ?? "0",
    pendingBatch: balanceRow?.pendingBatch ?? "0",
    pendingDeposits: (deposits.deposits ?? []).filter((deposit) => deposit.status === "pending"),
    arc,
    destinationToken: tokenAddressFromDomainInfo(arc),
  };
}

async function checkGateway({ quiet = false } = {}) {
  if (!account || gatewayCheckInProgress) return;
  gatewayCheckInProgress = true;
  try {
    const snapshot = await getGatewaySnapshot();
    const amount = parseUsdc(amountInput.value);
    const available = parseUsdc(snapshot.balance);
    const pendingText = snapshot.pendingDeposits.length
      ? `${snapshot.pendingDeposits.length} pending deposit(s)`
      : "no pending deposits";
    let message = `Gateway available: ${snapshot.balance} USDC\n${pendingText}`;

    if (!snapshot.arc) {
      message += "\nArc mainnet: not active in Gateway API yet.";
      setTransferReady(false);
    } else if (!snapshot.destinationToken) {
      message += "\nArc is active, but Gateway API has not published destinationToken.";
      setTransferReady(false);
    } else if (available < amount) {
      message += `\nWaiting for at least ${formatUnits(amount)} USDC to become available.`;
      setTransferReady(false);
    } else {
      message += "\nReady to estimate the fee and transfer to Arc.";
      setTransferReady(true);
    }
    setGatewayStatus(message);
  } catch (error) {
    setTransferReady(false);
    if (!quiet) setGatewayStatus(error.message || String(error), true);
  } finally {
    gatewayCheckInProgress = false;
  }
}

function startGatewayPolling() {
  clearInterval(gatewayTimer);
  checkGateway();
  gatewayTimer = setInterval(() => checkGateway({ quiet: true }), GATEWAY_POLL_MS);
}

async function connect() {
  await switchToBase();
  const accounts = await rpc("eth_requestAccounts");
  if (!accounts[0]) throw new Error("No wallet account selected.");
  account = accounts[0];
  connectButton.textContent = "Connected";
  await refresh();
  await checkGateway({ quiet: true });
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
  const [balance, allowance] = await Promise.all([
    readUint256({ to: BASE_USDC, data: encodeBalanceOf(account) }),
    readUint256({ to: BASE_USDC, data: encodeAllowance(account, GATEWAY_WALLET) }),
  ]);
  if (balance < units) {
    throw new Error(
      `Insufficient Base USDC: wallet has ${formatUnits(balance)} USDC, ` +
      `but deposit requires ${formatUnits(units)} USDC.`,
    );
  }
  if (allowance < units) {
    throw new Error("Allowance is too low. Click Approve first.");
  }
  setStatus("Deposit is waiting for your wallet…");
  const hash = await send({ to: GATEWAY_WALLET, data: encodeDeposit(BASE_USDC, units) });
  await refresh();
  setStatus(
    `Deposit confirmed on Base. Gateway is processing finality.\n${BASESCAN}${hash}`,
  );
  startGatewayPolling();
}

async function transferToArc() {
  if (!account) await connect();
  await switchToBase();
  const value = parseUsdc(amountInput.value);
  const snapshot = await getGatewaySnapshot();
  if (!snapshot.arc) throw new Error("Arc mainnet is not active in Gateway API yet.");
  if (!snapshot.destinationToken) throw new Error("Gateway API did not return Arc destinationToken.");
  const available = parseUsdc(snapshot.balance);
  if (available < value) throw new Error(`Gateway balance is only ${snapshot.balance} USDC.`);

  const spec = {
    version: 1,
    sourceDomain: 6,
    destinationDomain: ARC_DOMAIN,
    sourceContract: toBytes32(GATEWAY_WALLET),
    destinationContract: toBytes32(GATEWAY_MINTER),
    sourceToken: toBytes32(BASE_USDC),
    destinationToken: toBytes32(snapshot.destinationToken),
    sourceDepositor: toBytes32(account),
    destinationRecipient: toBytes32(account),
    sourceSigner: toBytes32(account),
    destinationCaller: toBytes32(ZERO_ADDRESS),
    value: value.toString(),
    salt: randomBytes32(),
    hookData: "0x",
  };

  setStatus("Estimating the Gateway fee…");
  const estimate = await gatewayRequest("/estimate?enableForwarder=true", [{ spec }]);
  const estimated = estimate.body?.[0]?.burnIntent;
  if (!estimated?.maxFee || !estimated?.maxBlockHeight) {
    throw new Error("Gateway estimate did not return maxFee and maxBlockHeight.");
  }
  const canonicalSpec = estimated.spec ?? spec;
  const maxFee = BigInt(estimated.maxFee);
  if (available < value + maxFee) {
    throw new Error(
      `Not enough Gateway balance including the fee: ${snapshot.balance} available, ` +
      `${formatUnits(value + maxFee)} required.`,
    );
  }

  const burnIntent = {
    maxBlockHeight: estimated.maxBlockHeight,
    maxFee: estimated.maxFee,
    spec: canonicalSpec,
  };
  const typedData = {
    domain: { name: "GatewayWallet", version: "1" },
    types: EIP712_TYPES,
    primaryType: "BurnIntent",
    message: burnIntent,
  };
  setStatus(`Estimated fee: ${formatUnits(maxFee)} USDC. Sign the burn intent in your wallet…`);
  const signature = await rpc("eth_signTypedData_v4", [account, JSON.stringify(typedData)]);

  setStatus("Submitting forwarded transfer to Gateway…");
  const response = await gatewayRequest("/transfer?enableForwarder=true", [
    { burnIntent, signature },
  ]);
  const transferId = response.transferId ?? response.id;
  if (!transferId) throw new Error("Gateway did not return a transferId.");
  setStatus(`Transfer submitted.\nTransfer ID: ${transferId}`);

  const deadline = Date.now() + TRANSFER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const details = await gatewayRequest(`/transfer/${transferId}`);
    if (details.status === "finalized" || details.status === "confirmed") {
      setStatus(
        `Transfer complete: ${formatUnits(value)} USDC forwarded to Arc.` +
        (details.transactionHash ? `\n${details.transactionHash}` : ""),
      );
      setTransferReady(false);
      return;
    }
    if (details.status === "failed") {
      throw new Error(`Forwarded transfer failed: ${details.forwardingDetails?.failureReason ?? "unknown"}`);
    }
    if (details.status === "expired") throw new Error("Forwarded transfer expired before minting.");
    await new Promise((resolve) => setTimeout(resolve, TRANSFER_POLL_MS));
  }
  throw new Error("Transfer polling timed out. Check the transfer ID in Gateway API.");
}

async function run(action) {
  const buttons = [approveButton, depositButton, checkGatewayButton, transferButton];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await action();
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    approveButton.disabled = false;
    depositButton.disabled = false;
    checkGatewayButton.disabled = false;
    transferButton.disabled = !transferReady;
  }
}

connectButton.addEventListener("click", () => run(connect));
approveButton.addEventListener("click", () => run(approve));
depositButton.addEventListener("click", () => run(deposit));
checkGatewayButton.addEventListener("click", () => run(() => checkGateway()));
transferButton.addEventListener("click", () => run(transferToArc));

if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", (accounts) => {
    account = accounts[0];
    setTransferReady(false);
    if (account) {
      refresh().catch((error) => setStatus(error.message, true));
      startGatewayPolling();
    }
  });
  window.ethereum.on?.("chainChanged", () => window.location.reload());
}
