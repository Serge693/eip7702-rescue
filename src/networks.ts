import { defineChain, type Chain } from "viem";

// ─────────────────────────────────────────────────────────────────────────────
// Add a new network:
//   1. Add entry to `networks` below.
//   2. Add RESCUER_<KEY> to .env (deploy once with: npx tsx src/index.ts deploy <key>)
//   3. Optionally add known tokens to KNOWN_TOKENS in tokens.ts
// That's it — all commands pick up the new network automatically.
// ─────────────────────────────────────────────────────────────────────────────

export const networks: Record<string, Chain> = {
  base: defineChain({
    id: 8453,
    name: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://mainnet.base.org"] } },
    blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } },
  }),

  ethereum: defineChain({
    id: 1,
    name: "Ethereum",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://ethereum.publicnode.com"] } },
    blockExplorers: { default: { name: "Etherscan", url: "https://etherscan.io" } },
  }),

  ink: defineChain({
    id: 57073,
    name: "Ink",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc-gel.inkonchain.com"] } },
    blockExplorers: { default: { name: "Ink Explorer", url: "https://explorer.inkonchain.com" } },
  }),

  arbitrum: defineChain({
    id: 42161,
    name: "Arbitrum One",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://arb1.arbitrum.io/rpc"] } },
    blockExplorers: { default: { name: "Arbiscan", url: "https://arbiscan.io" } },
  }),

  optimism: defineChain({
    id: 10,
    name: "Optimism",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://mainnet.optimism.io"] } },
    blockExplorers: { default: { name: "Optimism Explorer", url: "https://optimistic.etherscan.io" } },
  }),

  polygon: defineChain({
    id: 137,
    name: "Polygon",
    nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
    rpcUrls: { default: { http: ["https://polygon.publicnode.com"] } },
    blockExplorers: { default: { name: "Polygonscan", url: "https://polygonscan.com" } },
  }),
};

export type NetworkKey = keyof typeof networks;

export function getRpcUrl(key: string, network: Chain): string {
  return process.env[`RPC_URL_${key.toUpperCase()}`] ?? network.rpcUrls.default.http[0];
}
