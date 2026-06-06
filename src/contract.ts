import {
  type PublicClient,
  type WalletClient,
  type Hex,
  getContractAddress,
} from "viem";
import { type Account } from "viem/accounts";

// ─────────────────────────────────────────────────────────────────────────────
// Rescuer.sol ABI (only functions we call from TS)
// ─────────────────────────────────────────────────────────────────────────────
export const RESCUER_ABI = [
  {
    name: "claimAndSweepAll",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "claimContract", type: "address" },
      { name: "claimData",     type: "bytes"   },
      { name: "tokens",        type: "address[]" },
      { name: "destination",   type: "address" },
    ],
    outputs: [],
  },
  {
    name: "sweepAll",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokens",      type: "address[]" },
      { name: "destination", type: "address"   },
    ],
    outputs: [],
  },
  {
    name: "sweepEth",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "destination", type: "address" },
    ],
    outputs: [],
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Bytecode — compiled from contracts/Rescuer.sol
// solc 0.8.23, optimizer 200 runs, no constructor args.
//
// HOW TO UPDATE:
//   solc --optimize --optimize-runs 200 --bin contracts/Rescuer.sol
//   Replace RESCUER_BYTECODE with the output under "Binary:"
// ─────────────────────────────────────────────────────────────────────────────
//
// NOTE: The bytecode below is a placeholder.
// Run `npm run compile` to generate the real bytecode, then paste it here.
// Or use the deploy command which will compile on the fly via solc-js.
//
export const RESCUER_BYTECODE = "0x__PLACEHOLDER__COMPILE_WITH_NPM_RUN_COMPILE__" as Hex;

// ─────────────────────────────────────────────────────────────────────────────
// Resolve rescuer address for a network.
// Priority:
//   1. RESCUER_<NETWORKKEY> env var (pre-deployed, reused)
//   2. Deploy fresh (costs gas, but always works)
// ─────────────────────────────────────────────────────────────────────────────
export async function resolveRescuer(
  networkKey: string,
  publicClient: PublicClient,
  walletClient: WalletClient,
  sponsor: Account,
  bytecode: Hex,
  dryRun = false,
  log: (msg: string) => void = console.log,
): Promise<Hex> {
  const envKey = `RESCUER_${networkKey.toUpperCase()}`;
  const preDeployed = process.env[envKey];

  if (preDeployed?.startsWith("0x") && preDeployed.length === 42) {
    const code = await publicClient.getBytecode({ address: preDeployed as Hex }).catch(() => undefined);
    if (code && code.length > 2) {
      log(`  ✓ Rescuer (pre-deployed): ${preDeployed}`);
      return preDeployed as Hex;
    }
    log(`  ⚠ ${envKey} set but no code — deploying fresh`);
  }

  return deployRescuer(publicClient, walletClient, sponsor, bytecode, networkKey, dryRun, log);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deploy Rescuer contract
// ─────────────────────────────────────────────────────────────────────────────
export async function deployRescuer(
  publicClient: PublicClient,
  walletClient: WalletClient,
  sponsor: Account,
  bytecode: Hex,
  networkKey: string,
  dryRun = false,
  log: (msg: string) => void = console.log,
): Promise<Hex> {
  log(`  Deploying Rescuer contract...`);

  if (dryRun) {
    const nonce = await publicClient.getTransactionCount({ address: sponsor.address, blockTag: "pending" });
    const predicted = getContractAddress({ from: sponsor.address, nonce: BigInt(nonce) });
    log(`  [DRY-RUN] Would deploy → ${predicted}`);
    log(`  [DRY-RUN] Add to .env: RESCUER_${networkKey.toUpperCase()}=${predicted}`);
    return predicted;
  }

  const fees = await publicClient.estimateFeesPerGas().catch(async () => {
    const gp = await publicClient.getGasPrice();
    return { maxFeePerGas: (gp * 120n) / 100n, maxPriorityFeePerGas: (gp * 10n) / 100n };
  });

  let gas = 500_000n;
  try {
    const est = await publicClient.estimateGas({ account: sponsor.address, data: bytecode });
    gas = (est * 150n) / 100n;
  } catch {}

  const hash = await walletClient.sendTransaction({
    account: sponsor,
    data: bytecode,
    gas,
    maxFeePerGas: (fees.maxFeePerGas * 130n) / 100n,
    maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * 130n) / 100n,
  } as any);

  log(`  Deploy tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("Deploy reverted");
  if (!receipt.contractAddress) throw new Error("No contract address in receipt");

  log(`  ✓ Rescuer deployed: ${receipt.contractAddress}`);
  log(`  → Add to .env: RESCUER_${networkKey.toUpperCase()}=${receipt.contractAddress}`);
  return receipt.contractAddress;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build EIP-7702 authorization + send atomic tx
// ─────────────────────────────────────────────────────────────────────────────
export async function sendEip7702Tx(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  source: Account;
  sponsor: Account;
  rescuerAddress: Hex;
  networkId: number;
  calldata: Hex;
  label: string;
  dryRun?: boolean;
  log: (msg: string) => void;
  explorerUrl?: string;
}): Promise<{ success: boolean; hash?: Hex }> {
  const {
    publicClient, walletClient, source, sponsor,
    rescuerAddress, networkId, calldata, label,
    dryRun, log, explorerUrl,
  } = opts;

  const nonce = await publicClient.getTransactionCount({ address: source.address, blockTag: "pending" });
  const auth = await source.signAuthorization({ contractAddress: rescuerAddress, chainId: networkId, nonce });

  const fees = await publicClient.estimateFeesPerGas().catch(async () => {
    const gp = await publicClient.getGasPrice();
    return { maxFeePerGas: (gp * 120n) / 100n, maxPriorityFeePerGas: (gp * 10n) / 100n };
  });

  let gas = 300_000n;
  try {
    const est = await publicClient.estimateGas({
      account: sponsor.address,
      to: source.address,
      authorizationList: [auth],
      data: calldata,
    } as any);
    gas = (est * 150n) / 100n;
    if (gas < 200_000n) gas = 200_000n;
  } catch {}

  if (dryRun) {
    log(`  [DRY-RUN] Would send ${label} (gas: ${gas})`);
    return { success: true };
  }

  try {
    const hash = await walletClient.sendTransaction({
      account: sponsor,
      to: source.address,
      authorizationList: [auth],
      data: calldata,
      gas,
      maxFeePerGas: (fees.maxFeePerGas * 130n) / 100n,
      maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * 130n) / 100n,
    } as any);

    log(`  ${label} tx: ${hash}`);
    if (explorerUrl) log(`  ${explorerUrl}/tx/${hash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") {
      log(`  ✗ ${label} reverted`);
      return { success: false, hash };
    }
    log(`  ✓ ${label} confirmed`);
    return { success: true, hash };
  } catch (err: any) {
    log(`  ✗ ${label} failed: ${err.message}`);
    return { success: false };
  }
}
