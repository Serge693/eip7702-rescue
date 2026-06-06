import pc from "picocolors";

export function loadEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(pc.red(`\nError: ${key} is not set in .env`));
    process.exit(1);
  }
  if (key.endsWith("_PRIVATE_KEY") && (!val.startsWith("0x") || val.length !== 66)) {
    console.error(pc.red(`\nError: ${key} must be a 0x-prefixed 64-char hex string`));
    process.exit(1);
  }
  return val;
}

export function errorAndExit(msg: string): never {
  console.error(pc.red(`\nError: ${msg}`));
  process.exit(1);
}
