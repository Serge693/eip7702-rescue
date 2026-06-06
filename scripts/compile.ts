/**
 * scripts/compile.ts
 *
 * Compiles contracts/Rescuer.sol using solc-js (no external toolchain needed).
 * Extracts bytecode and ABI, then patches src/contract.ts automatically.
 *
 * Usage:
 *   npx tsx scripts/compile.ts
 *   npm run compile
 *
 * First run:
 *   npm install solc
 *   npm run compile
 */

import { readFileSync, writeFileSync } from "fs";
import { createRequire }               from "module";
import { fileURLToPath }               from "url";
import { dirname, resolve }            from "path";
import pc                              from "picocolors";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────
const SOL_PATH      = resolve(__dirname, "../contracts/Rescuer.sol");
const CONTRACT_TS   = resolve(__dirname, "../src/contract.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Load solc
// ─────────────────────────────────────────────────────────────────────────────
function loadSolc() {
  try {
    return require("solc");
  } catch {
    console.error(pc.red("\nsolc not found. Install it:"));
    console.error(pc.cyan("  npm install solc\n"));
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compile
// ─────────────────────────────────────────────────────────────────────────────
function compile(solc: any, source: string): { bytecode: string; abi: object[] } {
  const input = {
    language: "Solidity",
    sources: {
      "Rescuer.sol": { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "Rescuer.sol": {
          Rescuer: ["evm.bytecode.object", "abi"],
        },
      },
    },
  };

  const raw    = solc.compile(JSON.stringify(input));
  const output = JSON.parse(raw) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts?: Record<string, Record<string, {
      abi: object[];
      evm: { bytecode: { object: string } };
    }>>;
  };

  // Print warnings / errors
  for (const err of output.errors ?? []) {
    const fn = err.severity === "error" ? pc.red : pc.yellow;
    console.log(fn(err.formattedMessage));
  }

  const hasErrors = output.errors?.some(e => e.severity === "error");
  if (hasErrors) {
    console.error(pc.red("\nCompilation failed."));
    process.exit(1);
  }

  const contract = output.contracts?.["Rescuer.sol"]?.["Rescuer"];
  if (!contract) {
    console.error(pc.red("\nRescuer contract not found in compiler output."));
    process.exit(1);
  }

  const bytecode = contract.evm.bytecode.object;
  if (!bytecode || bytecode.length === 0) {
    console.error(pc.red("\nEmpty bytecode — compilation issue."));
    process.exit(1);
  }

  return { bytecode, abi: contract.abi };
}

// ─────────────────────────────────────────────────────────────────────────────
// Patch src/contract.ts
// Replaces the RESCUER_BYTECODE line in-place.
// ─────────────────────────────────────────────────────────────────────────────
function patchContractTs(bytecode: string): void {
  let src = readFileSync(CONTRACT_TS, "utf-8");

  const newLine = `export const RESCUER_BYTECODE = "0x${bytecode}" as Hex;`;

  // Match existing RESCUER_BYTECODE line (any value)
  const pattern = /^export const RESCUER_BYTECODE = "0x[^"]*" as Hex;$/m;

  if (!pattern.test(src)) {
    console.error(pc.red(
      `\nCould not find RESCUER_BYTECODE line in ${CONTRACT_TS}.\n` +
      `Make sure the line looks like:\n` +
      `  export const RESCUER_BYTECODE = "0x..." as Hex;\n`,
    ));
    process.exit(1);
  }

  src = src.replace(pattern, newLine);
  writeFileSync(CONTRACT_TS, src, "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Print ABI summary
// ─────────────────────────────────────────────────────────────────────────────
function printAbi(abi: object[]): void {
  const fns = (abi as any[]).filter(x => x.type === "function" || x.type === "receive");
  console.log(pc.dim("\n  ABI functions:"));
  for (const fn of fns) {
    if (fn.type === "receive") {
      console.log(pc.dim("    receive() payable"));
      continue;
    }
    const inputs = (fn.inputs as any[]).map((i: any) => `${i.type} ${i.name}`).join(", ");
    console.log(pc.dim(`    ${fn.name}(${inputs})`));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
function main(): void {
  console.log(pc.cyan("\n=== Compiling Rescuer.sol ===\n"));

  const solc   = loadSolc();
  const source = readFileSync(SOL_PATH, "utf-8");

  console.log(`  solc version : ${solc.version()}`);
  console.log(`  optimizer    : 200 runs`);
  console.log(`  source       : contracts/Rescuer.sol`);

  const { bytecode, abi } = compile(solc, source);

  console.log(pc.green(`\n  ✓ Compiled successfully`));
  console.log(`  bytecode     : ${bytecode.length / 2} bytes`);

  printAbi(abi);

  console.log(`\n  Patching src/contract.ts...`);
  patchContractTs(bytecode);
  console.log(pc.green(`  ✓ RESCUER_BYTECODE updated in src/contract.ts`));

  // Also write a standalone JSON artifact for reference
  const artifact = {
    contractName : "Rescuer",
    abi,
    bytecode     : `0x${bytecode}`,
    compiler     : solc.version(),
    optimizer    : { enabled: true, runs: 200 },
    compiledAt   : new Date().toISOString(),
  };

  const artifactPath = resolve(__dirname, "../contracts/Rescuer.json");
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), "utf-8");
  console.log(pc.green(`  ✓ ABI + bytecode saved to contracts/Rescuer.json`));

  console.log(pc.cyan("\n  Next step:"));
  console.log(`    npx tsx src/index.ts deploy base\n`);
}

main();
