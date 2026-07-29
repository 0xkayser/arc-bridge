// ═══════════════ Arc Bridge config — все адреса проверены on-chain 2026-07-30 ═══════════════
// Gateway mainnet-адреса одинаковы на всех EVM-чейнах (источник: Circle use-gateway skill).
// eth_getCode подтвердил деплой на Base и Arc перед написанием этого файла.

export const GATEWAY_WALLET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE"; // депозиты (Base)
export const GATEWAY_MINTER = "0x2222222d7164433c4C09B0b0D809a9b52C04C205"; // минт (Arc)
export const GATEWAY_API = process.env.GATEWAY_API || "https://gateway-api.circle.com/v1";

export const BASE = {
  name: "Base",
  chainId: 8453,
  rpc: process.env.BASE_RPC || "https://mainnet.base.org",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // канонический USDC на Base
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
