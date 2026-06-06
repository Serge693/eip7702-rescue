/**
 * guard.ts
 *
 * Guard daemon — watches the compromised wallet 24/7.
 * Reacts to ANY incoming Transfer (ERC-20) or ETH balance change
 * with an immediate atomic sweepAll via EIP-7702.
 *
 * The wallet stays permanently delegated to the Rescuer contract.
 * When something arrives → sweep fires in the same or next block.
 *
 * Usage:
 *   npx tsx src/index.ts guard base
 *   npx tsx src/index.ts guard          ← all networks
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  formatEther,
  formatUnits,
  encodeFunctionData,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import pc from "picocolors";

import { networks, getRpcUrl }                from "./networks.js";
import { discoverTokens, getTokenBalances, watchIncomingTransfers } from "./tokens.js";
import { resolveRescuer, sendEip7702Tx, RESCUER_ABI, RESCUER_BYTECODE } from "./contract.js";
import { loadEnv }                            from "./utils.js";

// ─────────────────────────────────────────────────────────────────────────────
// Per-network guard state
// ─────────────────────────────────────────────────────────────────────────────
type GuardState = {
  key: string;
  networkName: string;
  rescuerAddress: Hex;
  knownTokens: Set<string>;
  sweeping: boolean;
  explorerUrl?: string;
};

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(net: string, msg: string) {
  console.log(`[${ts()}] [${net.padEnd(8)}] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ensure delegation is set to rescuerAddress.
// Called at startup and after any tx that might have changed it.
// ─────────────────────────────────────────────────────────────────────────────
async function ensureDelegation(opts: {
  state: GuardState;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  source: ReturnType<typeof privateKeyToAccount>;
  sponsor: ReturnType<typeof privateKeyToAccount>;
  network: (typeof networks)[string];
}) {
  const { state, publicClient, walletClient, source, sponsor, network } = opts;

  const code = await publicClient.getBytecode({ address: source.address }).catch(() => undefined);
  const currentDelegate = code?.startsWith("0xef0100")
    ? ("0x" + code.slice(8)).toLowerCase()
    : null;

  if (currentDelegate === state.rescuerAddress.toLowerCase()) return; // already set

  log(state.key, currentDelegate
    ? `! Delegation changed (${currentDelegate}) — re-setting...`
    : "! No delegation — setting...",
  );

  const nonce = await publicClient.getTransactionCount({ address: source.address, blockTag: "pending" });
  const auth  = await source.signAuthorization({
    contractAddress: state.rescuerAddress,
    chainId: network.id,
    nonce,
  });

  const fees = await publicClient.estimateFeesPerGas().catch(async () => {
    const gp = await publicClient.getGasPrice();
    return { maxFeePerGas: (gp * 120n) / 100n, maxPriorityFeePerGas: (gp * 10n) / 100n };
  });

  try {
    const hash = await walletClient.sendTransaction({
      account: sponsor,
      to: source.address,
      authorizationList: [auth],
      data: "0x",
      gas: 60_000n,
      maxFeePerGas: (fees.maxFeePerGas * 130n) / 100n,
      maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * 130n) / 100n,
    } as any);
    await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    log(state.key, `✓ Delegation set → ${state.rescuerAddress}`);
  } catch (err: any) {
    log(state.key, `✗ Failed to set delegation: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute sweepAll — called when any incoming transfer is detected
// ─────────────────────────────────────────────────────────────────────────────
async function doSweep(opts: {
  state: GuardState;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  source: ReturnType<typeof privateKeyToAccount>;
  sponsor: ReturnType<typeof privateKeyToAccount>;
  network: (typeof networks)[string];
  destination: Address;
  newToken?: Address; // token that just arrived (from Transfer event)
}) {
  const { state, publicClient, walletClient, source, sponsor, network, destination, newToken } = opts;

  if (state.sweeping) {
    log(state.key, "  sweep already in progress — queuing");
    // Simple approach: let the in-progress sweep handle it
    return;
  }
  state.sweeping = true;

  try {
    // Add newly discovered token to known set
    if (newToken) state.knownTokens.add(newToken.toLowerCase());

    // Also refresh discovery occasionally (catches tokens we missed at startup)
    const fresh = await discoverTokens(publicClient, state.key, source.address, 50_000n);
    for (const t of fresh) state.knownTokens.add(t.toLowerCase());

    const allTokens = [...state.knownTokens] as Address[];

    // Check balances — skip if nothing to sweep
    const ethBal = await publicClient.getBalance({ address: source.address });
    const tokenBals = await getTokenBalances(publicClient, source.address, allTokens);

    if (ethBal === 0n && tokenBals.length === 0) {
      log(state.key, "  Nothing to sweep (balances all zero)");
      return;
    }

    // Log what we're sweeping
    if (ethBal > 0n) log(state.key, `  ETH: ${formatEther(ethBal)}`);
    for (const b of tokenBals) {
      log(state.key, `  ${b.symbol}: ${formatUnits(b.balance, b.decimals)}`);
    }

    // Ensure delegation is still active before sweeping
    await ensureDelegation({ state, publicClient, walletClient, source, sponsor, network });

    const calldata = encodeFunctionData({
      abi: RESCUER_ABI,
      functionName: "sweepAll",
      args: [allTokens, destination],
    });

    log(state.key, "→ sweepAll()...");
    const result = await sendEip7702Tx({
      publicClient, walletClient,
      source, sponsor,
      rescuerAddress: state.rescuerAddress,
      networkId: network.id,
      calldata,
      label: "sweepAll",
      log: (msg) => log(state.key, msg),
      explorerUrl: state.explorerUrl,
    });

    if (result.success) {
      log(state.key, pc.green("✓ Sweep complete"));
    }

    // Re-establish delegation after sweep (it's consumed by the tx)
    await ensureDelegation({ state, publicClient, walletClient, source, sponsor, network });

  } catch (err: any) {
    log(state.key, `✗ Sweep error: ${err.message}`);
  } finally {
    state.sweeping = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard a single network
// ─────────────────────────────────────────────────────────────────────────────
async function guardNetwork(networkKey: string) {
  const network = networks[networkKey];
  const source  = privateKeyToAccount(loadEnv("SOURCE_PRIVATE_KEY") as Hex);
  const sponsor = privateKeyToAccount(loadEnv("SPONSOR_PRIVATE_KEY") as Hex);
  const destination = loadEnv("DESTINATION_ADDRESS") as Address;

  const rpcUrl = getRpcUrl(networkKey, network);
  const publicClient = createPublicClient({ chain: network, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account: sponsor, chain: network, transport: http(rpcUrl) });

  log(networkKey, `Starting guard on ${network.name}`);
  log(networkKey, `Source:      ${source.address}`);
  log(networkKey, `Destination: ${destination}`);

  // Resolve rescuer
  const rescuerAddress = await resolveRescuer(
    networkKey, publicClient, walletClient, sponsor,
    RESCUER_BYTECODE, false, (msg) => log(networkKey, msg),
  );

  // Initial token discovery
  log(networkKey, "Discovering tokens...");
  const initialTokens = await discoverTokens(publicClient, networkKey, source.address);
  const knownTokens   = new Set(initialTokens.map(a => a.toLowerCase()));
  log(networkKey, `  ${knownTokens.size} token(s) in watch list`);

  const state: GuardState = {
    key: networkKey,
    networkName: network.name,
    rescuerAddress,
    knownTokens,
    sweeping: false,
    explorerUrl: network.blockExplorers?.default?.url,
  };

  // Ensure delegation at startup
  await ensureDelegation({ state, publicClient, walletClient, source, sponsor, network });

  const sweepOpts = { state, publicClient, walletClient, source, sponsor, network, destination };

  // ── Watch for incoming ERC-20 transfers ────────────────────────────────────
  const unwatch = watchIncomingTransfers(publicClient, source.address, (tokenAddress) => {
    log(networkKey, `⚡ Incoming transfer: ${tokenAddress}`);
    doSweep({ ...sweepOpts, newToken: tokenAddress });
  });

  log(networkKey, pc.green("✓ Watching for transfers... (Ctrl+C to stop)"));

  // ── Poll for ETH balance every 15s ────────────────────────────────────────
  // watchEvent doesn't catch native ETH arrivals
  const ethPoller = setInterval(async () => {
    try {
      const ethBal = await publicClient.getBalance({ address: source.address });
      if (ethBal > 0n) {
        log(networkKey, `⚡ ETH detected: ${formatEther(ethBal)}`);
        doSweep(sweepOpts);
      }
    } catch {}
  }, 15_000);

  // ── Check delegation every 10 min ─────────────────────────────────────────
  const delegationChecker = setInterval(async () => {
    await ensureDelegation({ state, publicClient, walletClient, source, sponsor, network });
  }, 10 * 60 * 1000);

  return () => {
    unwatch();
    clearInterval(ethPoller);
    clearInterval(delegationChecker);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
export async function runGuard(networkKey?: string) {
  const targets = networkKey
    ? [networkKey]
    : Object.keys(networks);

  const cleanups: Array<() => void> = [];

  for (const key of targets) {
    if (!networks[key]) {
      console.error(`Unknown network: ${key}`);
      continue;
    }
    try {
      const cleanup = await guardNetwork(key);
      cleanups.push(cleanup);
    } catch (err: any) {
      console.error(`[${key}] Failed to start guard: ${err.message}`);
    }
  }

  if (cleanups.length === 0) {
    console.error("No networks guarded. Exiting.");
    process.exit(1);
  }

  process.on("SIGINT", () => {
    console.log("\nStopping guard...");
    cleanups.forEach(fn => fn());
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}
