// ═══════════════ Arc Bridge config — mainnet EVM configuration ═══════════════
// Gateway mainnet contracts use the same addresses across supported EVM chains.
// Verify network support through the live Gateway API before transferring.

export const GATEWAY_WALLET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE"; // deposits (Base)
export const GATEWAY_MINTER = "0x2222222d7164433c4C09B0b0D809a9b52C04C205"; // mint (Arc)
export const GATEWAY_API = process.env.GATEWAY_API || "https://gateway-api.circle.com/v1";

export const BASE = {
  name: "Base",
  chainId: 8453,
  rpc: process.env.BASE_RPC || "https://mainnet.base.org",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // canonical Base USDC
  domain: 6,
  explorer: "https://basescan.org",
};

export const ARC = {
  name: "Arc",
  chainId: 5042,
  rpc: process.env.ARC_RPC || "https://5042.rpc.thirdweb.com",
  domain: 26,
  explorer: "https://arcscan.app",
};

// Polling defaults. Override with environment variables for a local run.
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15_000);
export const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 30 * 60_000);
