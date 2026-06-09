/**
 * src/intercept.ts
 *
 * Local RPC proxy that intercepts claim transactions from MetaMask.
 *
 * HOW IT WORKS:
 *   1. Starts a local HTTP server on localhost:8545
 *   2. You switch MetaMask's RPC to http://localhost:8545
 *   3. Go to the claim site, click Claim, confirm in MetaMask
 *   4. Proxy intercepts eth_sendTransaction / eth_sendRawTransaction
 *   5. Saves contract + data to claims/intercepted.json
 *   6. Returns an error to MetaMask (transaction NOT sent to network)
 *   7. You switch MetaMask RPC back to normal
 *   8. Run: npx tsx src/index.ts rescue <network> --claim claims/intercepted.json
 *
 * USAGE:
 *   npx tsx src/index.ts intercept base
 *   npx tsx src/index.ts intercept base --port 8545
 *   npx tsx src/index.ts intercept base --output claims/ofc.json
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPublicClient, http, hexToNumber, type Hex, type Address } from "viem";
import pc from "picocolors";
import { networks, getRpcUrl } from "./networks.js";
import { loadEnv } from "./utils.js";

// ─────────────────────────────────────────────────────────────────────────────
// Parse raw tx to extract to + data
// ─────────────────────────────────────────────────────────────────────────────
function parseRawTx(rawTx: string): { to: string; data: string } | null {
  try {
    // RLP-decode type-2 (EIP-1559) or legacy transaction
    // We use a simple approach: viem can parse this
    // rawTx starts with 0x02 (type 2) or 0x01 (type 1) or no prefix (legacy)
    const bytes = Buffer.from(rawTx.replace("0x", ""), "hex");
    const txType = bytes[0];

    // We'll extract using regex on hex string — reliable for our use case
    // to field is always a 20-byte address in the tx
    // Instead of full RLP decode, we use eth_decodeRawTransaction via RPC
    return null; // signal to use RPC fallback
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Forward any non-intercepted request to real RPC
// ─────────────────────────────────────────────────────────────────────────────
async function forwardToRpc(rpcUrl: string, body: object): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Read full request body
// ─────────────────────────────────────────────────────────────────────────────
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Save intercepted claim config
// ─────────────────────────────────────────────────────────────────────────────
function saveConfig(opts: {
  to: string;
  data: string;
  networkKey: string;
  outputPath: string;
  chainId?: number;
  sourceAddress?: string;
}) {
  const { to, data, networkKey, outputPath, chainId, sourceAddress } = opts;

  // hint_tokens filled at runtime from known network tokens
  const hintTokens: string[] = [];

  const config = {
    _intercepted: true,
    _intercepted_at: new Date().toISOString(),
    _source: sourceAddress ?? "unknown",
    _chain_id: chainId,
    name: `Intercepted claim — ${networkKey} — ${new Date().toLocaleDateString()}`,
    network: networkKey,
    contract: to,
    data: data,
    hint_tokens: hintTokens,
  };

  const absPath = resolve(process.cwd(), outputPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify(config, null, 2), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main intercept server
// ─────────────────────────────────────────────────────────────────────────────
export async function runIntercept(opts: {
  networkKey: string;
  port?: number;
  outputPath?: string;
}) {
  const { networkKey, port = 8545, outputPath = "claims/intercepted.json" } = opts;

  const network = networks[networkKey];
  if (!network) throw new Error(`Unknown network: ${networkKey}`);

  const rpcUrl = getRpcUrl(networkKey, network);

  // Try to get source address for display
  let sourceAddress: string | undefined;
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    sourceAddress = privateKeyToAccount(loadEnv("SOURCE_PRIVATE_KEY") as Hex).address;
  } catch {}

  console.log(`\n${pc.bold(pc.cyan("═".repeat(54)))}`);
  console.log(`${pc.bold(pc.cyan("  Intercept Proxy"))}`);
  console.log(`${pc.bold(pc.cyan("═".repeat(54)))}`);
  console.log(`  Network:  ${network.name} (chain ${network.id})`);
  console.log(`  Upstream: ${rpcUrl}`);
  console.log(`  Output:   ${outputPath}`);
  if (sourceAddress) console.log(`  Source:   ${sourceAddress}`);
  console.log();

  let intercepted = false;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers — MetaMask needs these
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    let parsed: any;
    try {
      const raw = await readBody(req);
      parsed = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // Handle batch requests
    const requests = Array.isArray(parsed) ? parsed : [parsed];
    const responses = await Promise.all(
      requests.map(rpcReq => handleRequest(rpcReq, {
        rpcUrl, network, networkKey, outputPath, sourceAddress,
        onIntercept: () => { intercepted = true; },
      }))
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]));
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(pc.green(`  ✓ Proxy running on http://localhost:${port}`));
    console.log();
    console.log(pc.bold("  Steps:"));
    console.log(`  ${pc.cyan("1.")} Open MetaMask → Settings → Networks → ${network.name}`);
    console.log(`  ${pc.cyan("2.")} Change RPC URL to: ${pc.yellow(`http://localhost:${port}`)}`);
    console.log(`  ${pc.cyan("3.")} Go to the claim site, connect wallet, click ${pc.yellow("Claim")}`);
    console.log(`  ${pc.cyan("4.")} ${pc.bold("Confirm")} in MetaMask — proxy will intercept and block`);
    console.log(`  ${pc.cyan("5.")} Switch MetaMask RPC back to: ${pc.dim(rpcUrl)}`);
    console.log(`  ${pc.cyan("6.")} Run: ${pc.yellow(`npx tsx src/index.ts rescue ${networkKey} --claim ${outputPath}`)}`);
    console.log();
    console.log(pc.dim("  Waiting for transaction... (Ctrl+C to stop)"));
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n  Stopping proxy...");
    server.close(() => process.exit(0));
  });

  // Keep alive
  await new Promise(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Handle individual RPC request
// ─────────────────────────────────────────────────────────────────────────────
async function handleRequest(
  rpcReq: any,
  opts: {
    rpcUrl: string;
    network: (typeof networks)[string];
    networkKey: string;
    outputPath: string;
    sourceAddress?: string;
    onIntercept: () => void;
  }
): Promise<object> {
  const { rpcReq: _, rpcUrl, network, networkKey, outputPath, sourceAddress, onIntercept } = {
    rpcReq, ...opts
  };

  const { method, params = [], id } = rpcReq;

  // ── eth_sendTransaction ────────────────────────────────────────────────────
  if (method === "eth_sendTransaction") {
    const txParams = params[0] ?? {};
    const to: string = txParams.to ?? "";
    const data: string = txParams.data ?? txParams.input ?? "0x";
    const from: string = txParams.from ?? "";
    const chainId = txParams.chainId ? hexToNumber(txParams.chainId) : network.id;

    return interceptAndSave({ to, data, from, chainId, networkKey, outputPath, sourceAddress, id, onIntercept });
  }

  // ── eth_sendRawTransaction ─────────────────────────────────────────────────
  if (method === "eth_sendRawTransaction") {
    const rawTx: string = params[0] ?? "";
    // Decode raw tx via upstream RPC
    try {
      const decoded = await forwardToRpc(rpcUrl, {
        jsonrpc: "2.0", id: 99999,
        method: "eth_decodeRawTransaction" ,
        params: [rawTx],
      }) as any;

      if (decoded?.result) {
        const to = decoded.result.to ?? "";
        const data = decoded.result.input ?? decoded.result.data ?? "0x";
        const from = decoded.result.from ?? sourceAddress ?? "";
        return interceptAndSave({ to, data, from, chainId: network.id, networkKey, outputPath, sourceAddress, id, onIntercept });
      }
    } catch {}

    // Fallback: parse manually using viem
    try {
      const { parseTransaction } = await import("viem");
      const tx = parseTransaction(rawTx as Hex);
      const to: string = (tx as any).to ?? "";
      const data: string = (tx as any).data ?? "0x";
      if (to && data && data !== "0x") {
        return interceptAndSave({ to, data, from: sourceAddress ?? "", chainId: network.id, networkKey, outputPath, sourceAddress, id, onIntercept });
      }
    } catch (parseErr: any) {
      console.log(pc.yellow(`  ⚠ Raw tx parse error: ${parseErr.message}`));
    }

    // Last resort: block but can't decode
    console.log(pc.yellow("  ⚠ eth_sendRawTransaction intercepted but could not decode"));
    console.log(pc.dim(`    Raw: ${rawTx.slice(0, 80)}...`));
    return {
      jsonrpc: "2.0", id,
      error: { code: -32603, message: "Transaction intercepted — could not decode. Check raw tx manually." },
    };
  }

  // ── eth_chainId ───────────────────────────────────────────────────────────
  // Always return correct chain to prevent MetaMask from showing wrong network
  if (method === "eth_chainId") {
    return { jsonrpc: "2.0", id, result: `0x${network.id.toString(16)}` };
  }

  if (method === "net_version") {
    return { jsonrpc: "2.0", id, result: String(network.id) };
  }

  // ── Forward everything else to real RPC ───────────────────────────────────
  try {
    const result = await forwardToRpc(rpcUrl, rpcReq);
    return result as object;
  } catch (err: any) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: err.message } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Intercept, log, save, return error to MetaMask
// ─────────────────────────────────────────────────────────────────────────────
function interceptAndSave(opts: {
  to: string;
  data: string;
  from: string;
  chainId: number;
  networkKey: string;
  outputPath: string;
  sourceAddress?: string;
  id: unknown;
  onIntercept: () => void;
}): object {
  const { to, data, from, chainId, networkKey, outputPath, sourceAddress, id, onIntercept } = opts;

  console.log();
  console.log(pc.green("  ⚡ Transaction intercepted!"));
  console.log(`  from:     ${from}`);
  console.log(`  to:       ${pc.yellow(to)}`);
  console.log(`  chainId:  ${chainId}`);
  console.log(`  data:     ${data.slice(0, 66)}...`);
  console.log(`  selector: ${data.slice(0, 10)}`);

  saveConfig({ to, data, networkKey, outputPath, chainId, sourceAddress: from || sourceAddress });

  console.log();
  const absPath2 = resolve(process.cwd(), outputPath);
  console.log(pc.green(`  ✓ Saved to ${absPath2}`));
  console.log();
  console.log(pc.bold("  Now:"));
  console.log(`  ${pc.cyan("1.")} Switch MetaMask RPC back to the normal endpoint`);
  console.log(`  ${pc.cyan("2.")} Run: ${pc.yellow(`npx tsx src/index.ts rescue ${networkKey} --claim ${outputPath} --dry-run`)}`);
  console.log(`  ${pc.cyan("3.")} If dry-run OK: ${pc.yellow(`npx tsx src/index.ts rescue ${networkKey} --claim ${outputPath}`)}`);
  console.log();

  onIntercept();

  // Return error so MetaMask thinks tx was rejected
  // This prevents the tx from being rebroadcast
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: 4001,
      message: "Transaction intercepted by EIP-7702 Rescue Tool. Switch MetaMask RPC back to normal and run the rescue command.",
    },
  };
}
