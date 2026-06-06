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
export const RESCUER_BYTECODE = "0x6080604052348015600e575f5ffd5b506106908061001c5f395ff3fe608060405260043610610036575f3560e01c806337d1271914610041578063cc01cc6e14610062578063fe7746af14610081575f5ffd5b3661003d57005b5f5ffd5b34801561004c575f5ffd5b5061006061005b36600461048f565b6100a0565b005b34801561006d575f5ffd5b5061006061007c3660046104df565b6100b9565b34801561008c575f5ffd5b5061006061009b36600461059d565b61015f565b6100a98161016b565b6100b48383836101e8565b505050565b5f5f876001600160a01b031687876040516100d59291906105b6565b5f604051808303815f865af19150503d805f811461010e576040519150601f19603f3d011682016040523d82523d5f602084013e610113565b606091505b5091509150816101415780604051639e7e26a360e01b815260040161013891906105c5565b60405180910390fd5b61014a8361016b565b6101558585856101e8565b5050505050505050565b6101688161016b565b50565b475f819003610178575050565b5f826001600160a01b0316826040515f6040518083038185875af1925050503d805f81146101c1576040519150601f19603f3d011682016040523d82523d5f602084013e6101c6565b606091505b50509050806100b457604051630db2c7f160e31b815260040160405180910390fd5b5f5b82811015610279575f848483818110610205576102056105fa565b905060200201602081019061021a919061059d565b90505f6102268261027f565b9050805f03610236575050610271565b5f61024283868461034b565b90508061026d57604051632b596cb760e01b81526001600160a01b0384166004820152602401610138565b5050505b6001016101ea565b50505050565b6040513060248201525f90819081906001600160a01b0385169060440160408051601f198184030181529181526020820180516001600160e01b03166370a0823160e01b179052516102d1919061060e565b5f60405180830381855afa9150503d805f8114610309576040519150601f19603f3d011682016040523d82523d5f602084013e61030e565b606091505b5091509150811580610321575060208151105b1561032f57505f9392505050565b808060200190518101906103439190610624565b949350505050565b6040516001600160a01b038381166024830152604482018390525f91829182919087169060640160408051601f198184030181529181526020820180516001600160e01b031663a9059cbb60e01b179052516103a7919061060e565b5f604051808303815f865af19150503d805f81146103e0576040519150601f19603f3d011682016040523d82523d5f602084013e6103e5565b606091505b5091509150816103f9575f92505050610425565b80515f0361040c57600192505050610425565b80806020019051810190610420919061063b565b925050505b9392505050565b5f5f83601f84011261043c575f5ffd5b50813567ffffffffffffffff811115610453575f5ffd5b6020830191508360208260051b850101111561046d575f5ffd5b9250929050565b80356001600160a01b038116811461048a575f5ffd5b919050565b5f5f5f604084860312156104a1575f5ffd5b833567ffffffffffffffff8111156104b7575f5ffd5b6104c38682870161042c565b90945092506104d6905060208501610474565b90509250925092565b5f5f5f5f5f5f608087890312156104f4575f5ffd5b6104fd87610474565b9550602087013567ffffffffffffffff811115610518575f5ffd5b8701601f81018913610528575f5ffd5b803567ffffffffffffffff81111561053e575f5ffd5b89602082840101111561054f575f5ffd5b60209190910195509350604087013567ffffffffffffffff811115610572575f5ffd5b61057e89828a0161042c565b9094509250610591905060608801610474565b90509295509295509295565b5f602082840312156105ad575f5ffd5b61042582610474565b818382375f9101908152919050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b634e487b7160e01b5f52603260045260245ffd5b5f82518060208501845e5f920191825250919050565b5f60208284031215610634575f5ffd5b5051919050565b5f6020828403121561064b575f5ffd5b81518015158114610425575f5ffdfea2646970667358221220f3eab612582632cb960ecf49e2e06598ce1e2a11a28b77bda3bad333f6a8eecb64736f6c63430008230033" as Hex;

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
