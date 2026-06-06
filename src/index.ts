/**
 * EIP-7702 Rescue Tool
 *
 * Commands:
 *   rescue <network> [--claim claims/l3.json] [--dry-run]
 *   guard  [network]
 *   scan   [network]
 *   deploy [network]
 */

import { config } from "dotenv";
config();

import pc from "picocolors";
import {
  createPublicClient,
  http,
  formatEther,
  formatUnits,
  type Hex,
} from "viem";

import { networks, getRpcUrl }              from "./networks.js";
import { discoverTokens, getTokenBalances } from "./tokens.js";
import { runRescue }                        from "./rescue.js";
import { runGuard }                         from "./guard.js";
import { errorAndExit }                     from "./utils.js";
import { privateKeyToAccount }              from "viem/accounts";

// ─────────────────────────────────────────────────────────────────────────────
// Help
// ─────────────────────────────────────────────────────────────────────────────
function help(): never {
  console.log(pc.cyan("\n=== EIP-7702 Rescue Tool ===\n"));
  console.log(pc.bold("Commands:"));
  console.log("  rescue <network> [--claim <file>] [--dry-run]");
  console.log("    Atomic claim + sweepAll in one EIP-7702 transaction.");
  console.log("    --claim <file>   Path to claim config JSON (optional)");
  console.log("    --dry-run        Simulate without sending transactions\n");

  console.log("  guard [network]");
  console.log("    Start 24/7 guard daemon. Sweeps on any incoming transfer.");
  console.log("    Omit network to guard ALL networks.\n");

  console.log("  scan [network]");
  console.log("    Show balances and discovered tokens. No transactions.\n");

  console.log("  deploy [network]");
  console.log("    Deploy Rescuer contract and print address for .env.\n");

  console.log(pc.bold("Required in .env:"));
  console.log("  SOURCE_PRIVATE_KEY      Compromised wallet private key");
  console.log("  SPONSOR_PRIVATE_KEY     Wallet that pays gas");
  console.log("  DESTINATION_ADDRESS     Where rescued funds go\n");

  console.log(pc.bold("Optional in .env:"));
  console.log("  RESCUER_BASE            Pre-deployed Rescuer on Base");
  console.log("  RESCUER_ETHEREUM        Pre-deployed Rescuer on Ethereum");
  console.log("  RESCUER_<NETWORK>       Pre-deployed Rescuer on any network");
  console.log("  RPC_URL_BASE            Custom RPC for Base");
  console.log("  RPC_URL_<NETWORK>       Custom RPC for any network");
  console.log("  SPONSOR_MIN_BALANCE     Min sponsor ETH (default: 0.005)\n");

  console.log(pc.bold("Claim config JSON format (claims/*.json):"));
  console.log("  {");
  console.log('    "name": "Layer3 Claim",');
  console.log('    "contract": "0x...",');
  console.log('    "data": "0x...",');
  console.log('    "hint_tokens": ["0x..."]   ← optional, auto-discovered anyway');
  console.log("  }\n");

  console.log(pc.bold("Examples:"));
  console.log("  npx tsx src/index.ts rescue base --claim claims/l3.json");
  console.log("  npx tsx src/index.ts rescue base --dry-run");
  console.log("  npx tsx src/index.ts guard base");
  console.log("  npx tsx src/index.ts guard");
  console.log("  npx tsx src/index.ts scan");
  console.log("  npx tsx src/index.ts deploy base\n");

  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan command
// ─────────────────────────────────────────────────────────────────────────────
async function runScan(networkKey?: string) {
  const sourceKey = process.env.SOURCE_PRIVATE_KEY;
  if (!sourceKey) errorAndExit("SOURCE_PRIVATE_KEY not set");
  const source = privateKeyToAccount(sourceKey as Hex);

  const targets = networkKey
    ? [[networkKey, networks[networkKey]]]
    : Object.entries(networks);

  console.log(pc.cyan(`\n=== Scan — ${source.address} ===\n`));

  for (const [key, network] of targets as [string, (typeof networks)[string]][]) {
    const rpcUrl = getRpcUrl(key, network);
    const client = createPublicClient({ chain: network, transport: http(rpcUrl) });

    try {
      const chainId = await client.getChainId();
      if (chainId !== network.id) { console.log(`${pc.bold(key.padEnd(12))} ${pc.yellow("chain mismatch")}`); continue; }
    } catch { console.log(`${pc.bold(key.padEnd(12))} ${pc.dim("RPC error")}`); continue; }

    const ethBal = await client.getBalance({ address: source.address });
    const tokens = await discoverTokens(client, key, source.address);
    const bals   = await getTokenBalances(client, source.address, tokens);

    const rescuerEnv = process.env[`RESCUER_${key.toUpperCase()}`];
    const rescuerTag = rescuerEnv ? pc.green(`[rescuer ✓]`) : pc.dim("[no rescuer]");

    console.log(`${pc.bold(key.padEnd(12))} ${rescuerTag}`);
    if (ethBal > 0n) console.log(`  ${network.nativeCurrency.symbol}: ${formatEther(ethBal)}`);
    for (const b of bals) console.log(`  ${b.symbol}: ${formatUnits(b.balance, b.decimals)}`);
    if (ethBal === 0n && bals.length === 0) console.log(`  ${pc.dim("(empty)")}`);
  }
  console.log();
}

// ─────────────────────────────────────────────────────────────────────────────
// Deploy command
// ─────────────────────────────────────────────────────────────────────────────
async function runDeploy(networkKey?: string) {
  // Imported lazily to avoid loading bytecode in other commands
  const { deployRescuer, RESCUER_BYTECODE } = await import("./contract.js");
  const {
    createWalletClient,
    http: _http,
  } = await import("viem");
  const { privateKeyToAccount: pK } = await import("viem/accounts");

  const sponsorKey = process.env.SPONSOR_PRIVATE_KEY;
  if (!sponsorKey) errorAndExit("SPONSOR_PRIVATE_KEY not set");
  const sponsor = pK(sponsorKey as Hex);

  const targets = networkKey
    ? [[networkKey, networks[networkKey]]]
    : Object.entries(networks);

  console.log(pc.cyan("\n=== Deploy Rescuer ===\n"));

  for (const [key, network] of targets as [string, (typeof networks)[string]][]) {
    const rpcUrl = getRpcUrl(key, network);
    const pub = createPublicClient({ chain: network, transport: http(rpcUrl) });
    const wal = createWalletClient({ account: sponsor, chain: network, transport: http(rpcUrl) });

    console.log(`\n${pc.bold(network.name)} (${network.id})`);

    const envKey = `RESCUER_${key.toUpperCase()}`;
    const existing = process.env[envKey];
    if (existing?.startsWith("0x") && existing.length === 42) {
      const code = await pub.getBytecode({ address: existing as Hex }).catch(() => undefined);
      if (code && code.length > 2) {
        console.log(`  ${pc.green(`Already deployed: ${existing}`)}`);
        continue;
      }
    }

    try {
      await deployRescuer(pub, wal, sponsor, RESCUER_BYTECODE, key, false, console.log);
    } catch (err: any) {
      console.log(`  ${pc.red(`Deploy failed: ${err.message}`)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) help();

  const cmd = args[0];

  switch (cmd) {
    case "rescue": {
      const networkKey = args[1];
      if (!networkKey || networkKey.startsWith("--")) errorAndExit("Usage: rescue <network> [--claim <file>] [--dry-run]");
      if (!networks[networkKey]) errorAndExit(`Unknown network "${networkKey}". Available: ${Object.keys(networks).join(", ")}`);

      const claimIdx = args.indexOf("--claim");
      const claimPath = claimIdx !== -1 ? args[claimIdx + 1] : undefined;
      const dryRun    = args.includes("--dry-run") || process.env.DRY_RUN === "true";

      await runRescue({ networkKey, claimPath, dryRun });
      break;
    }

    case "guard": {
      const networkKey = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      if (networkKey && !networks[networkKey]) errorAndExit(`Unknown network "${networkKey}". Available: ${Object.keys(networks).join(", ")}`);
      await runGuard(networkKey);
      break;
    }

    case "scan": {
      const networkKey = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      if (networkKey && !networks[networkKey]) errorAndExit(`Unknown network "${networkKey}"`);
      await runScan(networkKey);
      break;
    }

    case "deploy": {
      const networkKey = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      if (networkKey && !networks[networkKey]) errorAndExit(`Unknown network "${networkKey}"`);
      await runDeploy(networkKey);
      break;
    }

    default:
      errorAndExit(`Unknown command "${cmd}". Run with --help for usage.`);
  }
}

main().catch((err) => {
  console.error(pc.red(err.message || String(err)));
  process.exit(1);
});
