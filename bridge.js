#!/usr/bin/env node
// arc-bridge — Base → Circle Gateway → Arc
//
// Commands:
//   balance                 read Base/Gateway/Arc balances
//   deposit <amount>        approve (if needed) + GatewayWallet.deposit
//   wait <amount>           poll Gateway until the deposit is credited
//   diagnose [txHash]        explain why a deposit is not visible
//   transfer <amount>       estimate + EIP-712 sign + forwarded transfer
//
// The private key is read only from PRIVATE_KEY and is never printed or saved.

import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  pad,
  parseUnits,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, arc as arcChainDef } from "viem/chains";
import {
  GATEWAY_API,
  GATEWAY_MINTER,
  GATEWAY_WALLET,
  BASE,
  ARC,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
} from "./config.js";

const arcChain = {
  ...arcChainDef,
  rpcUrls: { default: { http: [ARC.rpc] } },
};

const gatewayWalletAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
];

const domain = { name: "GatewayWallet", version: "1" };
const types = {
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
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
};

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUsdc(value) {
  return formatUnits(BigInt(value), 6);
}

function toBytes32(address) {
  return pad(address.toLowerCase(), { size: 32 });
}

function getAccount() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    fail("PRIVATE_KEY is not set. Example: PRIVATE_KEY=0x... node bridge.js balance");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    fail("PRIVATE_KEY must be a hex string with 0x plus 64 characters");
  }
  return privateKeyToAccount(privateKey);
}

function clients() {
  const account = getAccount();
  return {
    account,
    basePublic: createPublicClient({ chain: base, transport: http(BASE.rpc) }),
    baseWallet: createWalletClient({ account, chain: base, transport: http(BASE.rpc) }),
    arcPublic: createPublicClient({ chain: arcChain, transport: http(ARC.rpc) }),
  };
}

async function confirm(question) {
  if (process.argv.includes("--yes")) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
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
  if (!response.ok) {
    fail(`Gateway API ${path}: ${response.status} ${text}`);
  }
  return json;
}

async function gatewayState(address) {
  const sources = [{ domain: BASE.domain, depositor: address }];
  const [balances, deposits] = await Promise.all([
    gatewayRequest("/balances", { token: "USDC", sources }),
    gatewayRequest("/deposits", { token: "USDC", sources }),
  ]);

  const balanceRow = (balances.balances ?? []).find(
    (row) => Number(row.domain) === BASE.domain,
  );
  return {
    balance: balanceRow?.balance ?? "0",
    pendingBatch: balanceRow?.pendingBatch ?? "0",
    deposits: deposits.deposits ?? [],
  };
}

function printGatewayState(state) {
  console.log(`Gateway available: ${state.balance} USDC`);
  console.log(`Gateway pendingBatch: ${state.pendingBatch} USDC`);
  const pending = state.deposits.filter((deposit) => deposit.status === "pending");
  if (pending.length === 0) {
    console.log("Gateway pending deposits: none");
  } else {
    for (const deposit of pending) {
      console.log(
        `Gateway pending deposit: ${deposit.amount} USDC, tx ${deposit.transactionHash ?? "?"}`,
      );
    }
  }
}

async function waitForReceipt(publicClient, hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    fail(`${label} reverted. Tx: ${hash}`);
  }
  return receipt;
}

async function cmdBalance() {
  const { account, basePublic, arcPublic } = clients();
  console.log(`Address: ${account.address}\n`);

  const [baseUsdc, gateway, baseNative] = await Promise.all([
    basePublic.readContract({
      address: BASE.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    gatewayState(account.address),
    basePublic.getBalance({ address: account.address }),
  ]);
  console.log(`Base USDC (wallet): ${formatUsdc(baseUsdc)} USDC`);
  console.log(`Base ETH (gas):    ${formatUnits(baseNative, 18)} ETH`);
  printGatewayState(gateway);

  try {
    const arcNative = await arcPublic.getBalance({ address: account.address });
    console.log(`Arc USDC (native): ${formatUnits(arcNative, 18)} USDC`);
  } catch (error) {
    console.log(`Arc RPC unavailable: ${error.shortMessage ?? error.message}`);
  }
}

async function cmdDeposit(amountString) {
  if (!amountString) fail("Enter an amount: node bridge.js deposit 25");
  const amount = parseUnits(amountString, 6);
  if (amount <= 0n) fail("Amount must be greater than zero");

  const { account, basePublic, baseWallet } = clients();
  const [balance, nativeBalance, allowance] = await Promise.all([
    basePublic.readContract({
      address: BASE.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    basePublic.getBalance({ address: account.address }),
    basePublic.readContract({
      address: BASE.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, GATEWAY_WALLET],
    }),
  ]);

  if (balance < amount) {
    fail(`Insufficient Base USDC: wallet has ${formatUsdc(balance)}, but ${amountString} is required`);
  }
  if (nativeBalance === 0n) {
    fail("The Base wallet has no ETH for approve/deposit gas");
  }

  console.log(`Deposit: ${amountString} USDC on Base → GatewayWallet`);
  console.log(`Wallet: ${account.address}`);
  console.log(`GatewayWallet: ${GATEWAY_WALLET}`);
  console.log(`Current allowance: ${formatUsdc(allowance)} USDC`);
  if (!(await confirm("Continue? An approve (if needed) and deposit transaction will be sent."))) {
    fail("Cancelled");
  }

  if (allowance < amount) {
    console.log("1/2 approve...");
    const approvalRequest = await basePublic.simulateContract({
      address: BASE.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [GATEWAY_WALLET, amount],
      account,
    });
    const approvalTx = await baseWallet.writeContract(approvalRequest.request);
    const approvalReceipt = await waitForReceipt(basePublic, approvalTx, "approve");
    console.log(`approve success in block ${approvalReceipt.blockNumber}`);
    console.log(`${BASE.explorer}/tx/${approvalTx}`);
  } else {
    console.log("1/2 approve skipped: allowance already sufficient");
  }

  console.log("2/2 deposit...");
  const depositRequest = await basePublic.simulateContract({
    address: GATEWAY_WALLET,
    abi: gatewayWalletAbi,
    functionName: "deposit",
    args: [BASE.usdc, amount],
    account,
  });
  const depositTx = await baseWallet.writeContract(depositRequest.request);
  const depositReceipt = await waitForReceipt(basePublic, depositTx, "deposit");
  console.log(`deposit success in block ${depositReceipt.blockNumber}`);
  console.log(`${BASE.explorer}/tx/${depositTx}`);
  console.log("\nDeposit confirmed on Base. Gateway may show it only after finality (~13–19 minutes).");
  console.log(`Check it with: PRIVATE_KEY=0x... node bridge.js wait ${amountString}`);
}

async function cmdWait(amountString) {
  if (!amountString) fail("Enter an amount: node bridge.js wait 25");
  const target = parseUnits(amountString, 6);
  if (target <= 0n) fail("Amount must be greater than zero");
  const { account } = clients();
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempt = 0;

  console.log(`Waiting for Gateway to credit at least ${amountString} USDC...`);
  while (Date.now() < deadline) {
    attempt += 1;
    const state = await gatewayState(account.address);
    const available = parseUnits(state.balance, 6);
    const pending = state.deposits.filter((deposit) => deposit.status === "pending");
    console.log(
      `[${attempt}] available=${state.balance} USDC, pendingBatch=${state.pendingBatch} USDC, pending=${pending.length}`,
    );
    if (available >= target) {
      console.log(`\n✓ Gateway sees ${state.balance} USDC. You can start the transfer.`);
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  fail(`Gateway wait timed out. Run diagnostics: node bridge.js diagnose`);
}

async function cmdDiagnose(txHash) {
  const { account, basePublic } = clients();
  console.log(`Address: ${account.address}`);

  const [baseCode, walletCode, usdcBalance, nativeBalance, allowance, state] = await Promise.all([
    basePublic.getBytecode({ address: BASE.usdc }),
    basePublic.getBytecode({ address: GATEWAY_WALLET }),
    basePublic.readContract({
      address: BASE.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    basePublic.getBalance({ address: account.address }),
    basePublic.readContract({
      address: BASE.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, GATEWAY_WALLET],
    }),
    gatewayState(account.address),
  ]);

  console.log(`Base USDC contract code: ${baseCode ? "found" : "MISSING"}`);
  console.log(`GatewayWallet code:      ${walletCode ? "found" : "MISSING"}`);
  console.log(`Base USDC wallet:        ${formatUsdc(usdcBalance)} USDC`);
  console.log(`Base ETH for gas:        ${formatUnits(nativeBalance, 18)} ETH`);
  console.log(`Gateway allowance:       ${formatUsdc(allowance)} USDC`);
  printGatewayState(state);

  if (txHash) {
    console.log(`\nTransaction: ${txHash}`);
    const receipt = await basePublic.getTransactionReceipt({ hash: txHash });
    console.log(`Receipt status: ${receipt.status}`);
    console.log(`Block: ${receipt.blockNumber}`);
    console.log(`Logs: ${receipt.logs.length}`);
    if (receipt.status !== "success") {
      console.log("Cause: the transaction reverted. Repeat the deposit after fixing the issue.");
    }
    console.log(`${BASE.explorer}/tx/${txHash}`);
  }
}

function findDomainInfo(info, domainId) {
  return (info.domains ?? []).find((item) => Number(item.domain) === domainId);
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

async function getDestinationToken() {
  const info = await gatewayRequest("/info");
  const destination = findDomainInfo(info, ARC.domain);
  if (!destination) {
    const active = (info.domains ?? []).map((item) => `${item.chain}(${item.domain})`).join(", ");
    fail(
      `Gateway mainnet does not currently list an active network for domain ${ARC.domain} (Arc). ` +
      `Active domains: ${active}. Base deposits work, but transfers cannot start yet.`,
    );
  }

  const apiToken = tokenAddressFromDomainInfo(destination);
  const configuredToken = process.env.DESTINATION_TOKEN;
  if (apiToken) return apiToken;
  if (configuredToken && /^0x[0-9a-fA-F]{40}$/.test(configuredToken)) {
    return configuredToken;
  }
  fail(
    `Gateway /info lists Arc as active but did not return a USDC address. ` +
    `Set DESTINATION_TOKEN to the address from the Circle API; do not guess it.`,
  );
}

async function cmdTransfer(amountString) {
  if (!amountString) fail("Enter an amount: node bridge.js transfer 25");
  const value = parseUnits(amountString, 6);
  if (value <= 0n) fail("Amount must be greater than zero");
  const { account } = clients();
  const state = await gatewayState(account.address);
  const available = parseUnits(state.balance, 6);
  if (available < value) {
    fail(`Gateway sees only ${state.balance} USDC. Wait first: node bridge.js wait ${amountString}`);
  }

  const destinationToken = await getDestinationToken();
  const spec = {
    version: 1,
    sourceDomain: BASE.domain,
    destinationDomain: ARC.domain,
    sourceContract: toBytes32(GATEWAY_WALLET),
    destinationContract: toBytes32(GATEWAY_MINTER),
    sourceToken: toBytes32(BASE.usdc),
    destinationToken: toBytes32(destinationToken),
    sourceDepositor: toBytes32(account.address),
    destinationRecipient: toBytes32(account.address),
    sourceSigner: toBytes32(account.address),
    destinationCaller: toBytes32(zeroAddress),
    value,
    salt: `0x${randomBytes(32).toString("hex")}`,
    hookData: "0x",
  };

  console.log(`Transfer: ${amountString} USDC Gateway(Base) → Arc`);
  console.log(`Destination token from Circle API: ${destinationToken}`);
  console.log("Estimating fee with forwarding enabled...");
  const estimate = await gatewayRequest("/estimate?enableForwarder=true", [{ spec }]);
  const estimated = estimate.body?.[0]?.burnIntent;
  if (!estimated?.maxFee || !estimated?.maxBlockHeight) {
    fail(`Estimate API returned no burnIntent: ${JSON.stringify(estimate)}`);
  }
  const maxFee = BigInt(estimated.maxFee);
  const maxBlockHeight = BigInt(estimated.maxBlockHeight);
  const canonicalSpec = estimated.spec ?? spec;
  if (available < value + maxFee) {
    fail(
      `Insufficient Gateway balance including the fee: ${state.balance} available, ` +
      `${formatUsdc(value + maxFee)} USDC required.`,
    );
  }

  console.log(`Estimated maxFee: ${formatUsdc(maxFee)} USDC`);
  console.log(`Burn intent expires at source block: ${maxBlockHeight}`);
  if (!(await confirm("Sign the intent and submit a forwarded transfer?"))) fail("Cancelled");

  const burnIntent = { maxBlockHeight, maxFee, spec: canonicalSpec };
  const signature = await account.signTypedData({
    domain,
    types,
    primaryType: "BurnIntent",
    message: burnIntent,
  });

  const response = await gatewayRequest("/transfer?enableForwarder=true", [
    { burnIntent, signature },
  ]);
  const transferId = response.transferId ?? response.id;
  if (!transferId) fail(`Transfer API returned no transferId: ${JSON.stringify(response)}`);
  console.log(`Transfer ID: ${transferId}`);
  console.log("Forwarder is handling the Arc mint; polling status...");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const details = await gatewayRequest(`/transfer/${transferId}`);
    console.log(`Status: ${details.status}`);
    if (details.status === "finalized" || details.status === "confirmed") {
      console.log(`✓ Transfer complete: ${amountString} USDC on Arc`);
      if (details.transactionHash) console.log(`Destination tx: ${details.transactionHash}`);
      return;
    }
    if (details.status === "failed") {
      fail(`Forwarded transfer failed: ${details.forwardingDetails?.failureReason ?? "unknown"}`);
    }
    if (details.status === "expired") fail("Forwarded transfer expired before minting");
    await sleep(POLL_INTERVAL_MS);
  }
  fail(`Transfer polling timed out. Transfer ID: ${transferId}`);
}

const [, , command, firstArg] = process.argv;
const commands = {
  balance: cmdBalance,
  deposit: () => cmdDeposit(firstArg),
  wait: () => cmdWait(firstArg),
  diagnose: () => cmdDiagnose(firstArg),
  transfer: () => cmdTransfer(firstArg),
};

if (!commands[command]) {
  console.log("Usage: PRIVATE_KEY=0x... node bridge.js <balance|deposit|wait|diagnose|transfer> [amount|txHash] [--yes]");
  process.exit(1);
}

commands[command]().catch((error) => {
  console.error(`✗ ${error.shortMessage ?? error.message ?? String(error)}`);
  process.exit(1);
});
