import { type PublicClient, type Address, type Hex, keccak256, toBytes } from "viem";

// ─────────────────────────────────────────────────────────────────────────────
// Known tokens per network (seed list — auto-discovery adds more)
// Add any token you expect to receive on the compromised wallet.
// ─────────────────────────────────────────────────────────────────────────────
export const KNOWN_TOKENS: Record<string, Address[]> = {
  base: [
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
    "0x4200000000000000000000000000000000000006", // WETH
    "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
    "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH
    "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", // EURC
  ],
  ethereum: [
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
    "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  ],
  ink: [
    "0x4200000000000000000000000000000000000006", // WETH
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  ],
  arbitrum: [
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
    "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
    "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
  ],
  optimism: [
    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // USDC
    "0x4200000000000000000000000000000000000006", // WETH
    "0x4200000000000000000000000000000000000042", // OP
  ],
  polygon: [
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC
    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
  ],
};

// ERC-20 Transfer event topic
const TRANSFER_TOPIC: Hex = keccak256(toBytes("Transfer(address,address,uint256)"));

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Discover tokens that were ever sent TO `address` via Transfer events.
// Scans the last `blockRange` blocks (default: ~30 days on Base ≈ 1_300_000).
// Deduplicates and merges with KNOWN_TOKENS for the network.
// ─────────────────────────────────────────────────────────────────────────────
export async function discoverTokens(
  client: PublicClient,
  networkKey: string,
  address: Address,
  blockRange = 1_300_000n,
): Promise<Address[]> {
  const known = new Set<string>((KNOWN_TOKENS[networkKey] ?? []).map(a => a.toLowerCase()));

  try {
    const latest = await client.getBlockNumber();
    const fromBlock = latest > blockRange ? latest - blockRange : 0n;

    // address padded to 32 bytes as topic (indexed param)
    const addressTopic = `0x000000000000000000000000${address.slice(2).toLowerCase()}` as Hex;

    const logs = await client.getLogs({
      fromBlock,
      toBlock: "latest",
      topics: [
        TRANSFER_TOPIC,
        null,          // from: any
        addressTopic,  // to: our address
      ],
    });

    for (const log of logs) {
      known.add(log.address.toLowerCase());
    }
  } catch {
    // getLogs may fail on some RPCs — fall back to known list only
  }

  return [...known] as Address[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Check which tokens from the list have non-zero balance on `address`.
// Returns array of { address, symbol, balance, decimals }.
// ─────────────────────────────────────────────────────────────────────────────
export async function getTokenBalances(
  client: PublicClient,
  address: Address,
  tokens: Address[],
): Promise<{ address: Address; symbol: string; balance: bigint; decimals: number }[]> {
  const results: { address: Address; symbol: string; balance: bigint; decimals: number }[] = [];

  await Promise.all(
    tokens.map(async (token) => {
      try {
        const balance = await client.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        }) as bigint;

        if (balance === 0n) return;

        let symbol = token.slice(0, 8);
        let decimals = 18;
        try {
          symbol = await client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }) as string;
          decimals = await client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }) as number;
        } catch {}

        results.push({ address: token, symbol, balance, decimals });
      } catch {}
    }),
  );

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Watch for new Transfer events arriving TO `address` in real time.
// Calls `onTransfer(tokenAddress)` whenever a new transfer is detected.
// Returns an unwatch function.
// ─────────────────────────────────────────────────────────────────────────────
export function watchIncomingTransfers(
  client: PublicClient,
  address: Address,
  onTransfer: (tokenAddress: Address) => void,
): () => void {
  const addressTopic = `0x000000000000000000000000${address.slice(2).toLowerCase()}` as Hex;

  return client.watchEvent({
    topics: [TRANSFER_TOPIC, null, addressTopic],
    onLogs: (logs) => {
      for (const log of logs) {
        onTransfer(log.address as Address);
      }
    },
  });
}
