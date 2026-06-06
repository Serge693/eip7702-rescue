# Claim configs

Each JSON file describes one claimable reward.

## Format

```json
{
  "name": "Human-readable name",
  "contract": "0x...claim contract address",
  "data":     "0x...calldata to send",
  "hint_tokens": ["0x...token you expect to receive"]
}
```

`hint_tokens` is optional — the tool auto-discovers tokens via Transfer event logs regardless.
Add it only if you know the exact token address in advance (speeds up the sweep list).

## How to get `contract` and `data`

1. Open the claim page in your browser (L3, OFC, Hedgey, etc.)
2. Open DevTools → Network tab
3. Click Claim
4. Find the transaction in MetaMask **before** confirming — copy:
   - `to` → `contract`
   - `data` → `data`
5. Cancel in MetaMask (don't send — the tool will send it atomically)

Or use a block explorer to find a previous claim tx from another wallet
and decode the calldata.

## Example

```json
{
  "name": "Layer3 CUBE claim",
  "contract": "0x1234...abcd",
  "data": "0xabcdef01...",
  "hint_tokens": ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"]
}
```

## Usage

```bash
npx tsx src/index.ts rescue base --claim claims/l3.json
npx tsx src/index.ts rescue base --claim claims/ofc.json --dry-run
```
