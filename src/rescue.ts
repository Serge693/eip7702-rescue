/**
 * rescue.ts
 *
 * One-shot rescue: atomic claim + sweepAll in a single EIP-7702 transaction.
 * The compromised wallet never holds tokens between claim and transfer.
 *
 * Usage:
 *   npx tsx src/index.ts rescue base --claim claims/l3.json
 *   npx tsx src/index.ts rescue base                         ← sweep only (no claim)
 *   npx tsx src/index.ts rescue base --dry-run
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  formatUnits,
  encodeFunctionData,
  zeroAddress,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import pc from "picocolors";

import { networks, getRpcUrl }         from "./networks.js";
import { discoverTokens, getTokenBalances } from "./tokens.js";
import { resolveRescuer, sendEip7702Tx, RESCUER_ABI, RESCUER_BYTECODE } from "./contract.js";
import { loadEnv }                     from "./utils.js";

// ─────────────────────────────────────────────────────────────────────────────
// Claim config file format
// ─────────────────────────────────────────────────────────────────────────────
interface ClaimConfig {
  name?: string;
  contract: Hex;
  data: Hex;
  // Optional hints — tokens you expect to receive.
  // Auto-discovery runs regardless, these just add to the list.
  hint_tokens?: Address[];
}

function loadClaimConfig(path: string): ClaimConfig {
  try {
    const raw = readFileSync(path, "utf-8");
    const cfg = JSON.parse(raw) as ClaimConfig;
    if (!cfg.contract?.startsWith("0x")) throw new Error("Missing or invalid 'contract'");
    if (!cfg.data?.startsWith("0x"))     throw new Error("Missing or invalid 'data'");
    return cfg;
  } catch (err: any) {
    throw new Error(`Failed to load claim config "${path}": ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main rescue function
// ─────────────────────────────────────────────────────────────────────────────
export async function runRescue(opts: {
  networkKey: string;
  claimPath?: string;
  selfClaim?: boolean;
  dryRun?: boolean;
}) {
  const { networkKey, claimPath, selfClaim, dryRun } = opts;

  const network = networks[networkKey];
  if (!network) throw new Error(`Unknown network: ${networkKey}`);

  const log = (msg: string) => console.log(msg);

  log(`\n${pc.bold("═".repeat(54))}`);
  log(`${pc.bold(pc.cyan(`  ${network.name} — Rescue`))}`);
  log(`${pc.bold("═".repeat(54))}`);

  // ── Load accounts ──────────────────────────────────────────────────────────
  const source      = privateKeyToAccount(loadEnv("SOURCE_PRIVATE_KEY") as Hex);
  const sponsor     = privateKeyToAccount(loadEnv("SPONSOR_PRIVATE_KEY") as Hex);
  const destination = loadEnv("DESTINATION_ADDRESS") as Address;

  log(`  Source:      ${source.address}`);
  log(`  Sponsor:     ${sponsor.address}`);
  log(`  Destination: ${destination}`);

  const rpcUrl = getRpcUrl(networkKey, network);
  const publicClient  = createPublicClient({ chain: network, transport: http(rpcUrl) });
  const walletClient  = createWalletClient({ account: sponsor, chain: network, transport: http(rpcUrl) });

  // ── RPC health ─────────────────────────────────────────────────────────────
  try {
    const chainId = await publicClient.getChainId();
    if (chainId !== network.id) {
      log(`  ${pc.yellow(`RPC chain mismatch (got ${chainId}, expected ${network.id}). Skipping.`)}`);
      return;
    }
  } catch (err: any) {
    log(`  ${pc.yellow(`RPC error: ${err.message}. Skipping.`)}`);
    return;
  }

  // ── Sponsor balance check ──────────────────────────────────────────────────
  const sponsorBal = await publicClient.getBalance({ address: sponsor.address });
  const minSponsor = BigInt(process.env.SPONSOR_MIN_BALANCE
    ? Math.floor(parseFloat(process.env.SPONSOR_MIN_BALANCE) * 1e18)
    : 5_000_000_000_000_000n); // 0.005 ETH

  if (sponsorBal < minSponsor) {
    log(`  ${pc.red(`Sponsor balance too low: ${formatEther(sponsorBal)}. Need ≥ ${formatEther(minSponsor)}.`)}`);
    return;
  }
  log(`  Sponsor bal: ${formatEther(sponsorBal)} ${network.nativeCurrency.symbol} ✓`);

  // ── Resolve rescuer contract ───────────────────────────────────────────────
  const rescuerAddress = await resolveRescuer(
    networkKey, publicClient, walletClient, sponsor,
    RESCUER_BYTECODE, dryRun, log,
  );

  // ── Load claim config (optional) ───────────────────────────────────────────
  let claim: ClaimConfig | undefined;
  if (claimPath) {
    claim = loadClaimConfig(claimPath);
    log(`  Claim:       ${claim.name ?? claimPath}`);
    log(`  Contract:    ${claim.contract}`);
  }

  // ── Discover tokens ────────────────────────────────────────────────────────
  log(`\n  ${pc.cyan("Discovering tokens...")}`);
  const discovered = await discoverTokens(publicClient, networkKey, source.address);

  // Merge with claim hints
  const hintSet = new Set(discovered.map(a => a.toLowerCase()));
  for (const t of claim?.hint_tokens ?? []) hintSet.add(t.toLowerCase());
  const allTokens = [...hintSet] as Address[];

  log(`  Found ${allTokens.length} candidate token(s) to sweep`);

  // Show current balances (informational)
  const balances = await getTokenBalances(publicClient, source.address, allTokens);
  const ethBal   = await publicClient.getBalance({ address: source.address });

  if (ethBal > 0n) {
    log(`  ${network.nativeCurrency.symbol}: ${formatEther(ethBal)}`);
  }
  for (const b of balances) {
    log(`  ${b.symbol}: ${formatUnits(b.balance, b.decimals)} (${b.address})`);
  }

  if (ethBal === 0n && balances.length === 0 && !claim) {
    log(`\n  ${pc.dim("Nothing to rescue (no balance, no claim). Skipping.")}`);
    return;
  }

  // ── Build calldata ─────────────────────────────────────────────────────────
  const explorerUrl = network.blockExplorers?.default?.url;
  let calldata: Hex;
  let label: string;

  if (claim) {
    const fn = selfClaim ? "selfClaimAndSweep" : "claimAndSweepAll";
    calldata = encodeFunctionData({
      abi: RESCUER_ABI,
      functionName: fn,
      args: [claim.contract, claim.data, allTokens, destination],
    });
    label = fn + "()";
    if (selfClaim) log(`  ${pc.yellow("Mode: selfClaimAndSweep (delegatecall) — for signature-based claims like OFC")}`);
  } else {
    calldata = encodeFunctionData({
      abi: RESCUER_ABI,
      functionName: "sweepAll",
      args: [allTokens, destination],
    });
    label = "sweepAll()";
  }

  // ── Send atomic EIP-7702 tx ────────────────────────────────────────────────
  log(`\n  ${pc.cyan(`Sending ${label}...`)}`);
  const result = await sendEip7702Tx({
    publicClient, walletClient,
    source, sponsor,
    rescuerAddress,
    networkId: network.id,
    calldata,
    label,
    dryRun,
    log,
    explorerUrl,
  });

  if (!result.success) {
    log(`\n  ${pc.red("Rescue failed. Funds NOT moved.")}`);
    return;
  }

  // ── Revoke delegation ──────────────────────────────────────────────────────
  if (!dryRun) {
    log(`\n  ${pc.cyan("Revoking delegation...")}`);
    await sendEip7702Tx({
      publicClient, walletClient,
      source, sponsor,
      rescuerAddress: zeroAddress,
      networkId: network.id,
      calldata: "0x",
      label: "revoke delegation",
      dryRun,
      log,
      explorerUrl,
    });
  }

  log(`\n  ${pc.green("✓ Rescue complete")}`);
}
