# When Revoking Isn't Enough: Building a Tool to Outrun the Bot

*Part 6 of the EIP-7702 series*

---

The previous five parts of this series were about revocation. How to revoke a malicious EIP-7702 delegation when you have no gas. How to do it from a browser. How to do it without a server. How to do it as a public service anyone can use.

Revocation solves one problem: removing a delegation that shouldn't be there.

But there's a different problem. One that revocation can't touch.

What happens when your wallet is so thoroughly compromised that there's nothing left to protect — and you're just waiting for something new to arrive?

---

## The problem revocation doesn't solve

Here's the scenario. Your wallet's private key was stolen months ago. The attacker has already drained everything. You can't migrate to a new wallet because you have ongoing vesting schedules, pending airdrops, and claimable rewards tied to the old address. You can't just walk away.

Every time something arrives — a token unlock, a Layer3 reward, an airdrop — a sweeper bot grabs it within seconds. The bot is watching 24/7. It's automated. It's fast. It doesn't sleep.

You, by contrast, have to notice that a claim is available, navigate to the right site, execute the claim, then transfer the tokens — all before the bot reacts. You won't win that race. Not manually.

This is the situation I was in. The Plume rescue attempt made it concrete.

---

## The Plume incident

In early June 2026, a Hedgey vesting claim became available on Plume network. 451 WPLUME — not nothing. We had a script ready. We ran the claim. It confirmed. We ran the transfer. It was too late.

The sweeper bot moved in 2 seconds after the claim confirmed. By the time the transfer script executed, the tokens were gone.

The specific failure: claim and transfer were two separate transactions. Between them, the bot had a window. Two seconds was enough.

The second failure: we expected PLUME but received WPLUME — a wrapped variant the script wasn't checking for. So even if the timing had worked, we would have missed it.

These two failures pointed directly at what a proper solution requires:

1. Claim and transfer must happen in a **single atomic transaction**. Either both succeed in the same block, or neither does. No window for the bot.
2. Token discovery must be **automatic**. You can't hardcode which token you expect. The contract might return a wrapped version, a different address, or multiple tokens at once.

---

## What EIP-7702 actually enables here

EIP-7702 is usually talked about in the context of revocation or gasless transactions. But it has another capability that's directly relevant here.

When a wallet is delegated to a smart contract, that contract's functions are callable on the wallet's address. The wallet itself becomes executable.

This means you can do the following:

1. Pre-deploy a `Rescuer` contract with a `claimAndSweepAll` function.
2. Delegate the compromised wallet to that contract via EIP-7702 (signed by the compromised wallet, gas paid by a sponsor).
3. Call `claimAndSweepAll` — which calls the claim contract, then immediately transfers every token with a nonzero balance to a safe destination.

All of that happens inside a single EIP-7702 type-4 transaction. One block. One shot.

```solidity
function claimAndSweepAll(
    address claimContract,
    bytes calldata claimData,
    address[] calldata tokens,
    address destination
) external {
    // 1. Execute the claim
    (bool ok, bytes memory reason) = claimContract.call(claimData);
    if (!ok) revert ClaimFailed(reason);

    // 2. Sweep ETH
    if (address(this).balance > 0)
        destination.call{value: address(this).balance}("");

    // 3. Sweep every token with nonzero balance
    for (uint256 i = 0; i < tokens.length; i++) {
        uint256 bal = _balanceOf(tokens[i]);
        if (bal > 0) _transfer(tokens[i], destination, bal);
    }
}
```

The `tokens` array doesn't need to be exact. Pass every address that might have a balance — PLUME, WPLUME, both stablecoins, WETH. Anything with zero balance is silently skipped. Anything with a balance gets swept. The bot has no window because there is no window.

---

## Automatic token discovery

The contract handles the sweep. But how do you know which tokens to pass?

The tool solves this by scanning Transfer event logs. Every ERC-20 transfer emits a `Transfer(address indexed from, address indexed to, uint256 value)` event. If you query for all Transfer events where `to == compromised address` over the last several hundred thousand blocks, you get a complete list of every token that has ever arrived at that address.

```typescript
const logs = await client.getLogs({
  fromBlock: latest - 1_300_000n,  // ~30 days on Base
  toBlock: "latest",
  topics: [
    TRANSFER_TOPIC,
    null,           // from: any
    addressTopic,   // to: our address
  ],
});
```

Each log's `address` field is a token contract. Collect them, deduplicate, merge with any known tokens for the network. The result is passed to `claimAndSweepAll` as the token list.

This is what would have saved the Plume rescue. We didn't know WPLUME's address. The logs would have found it — because WPLUME had arrived at the address during the claim, and Transfer events are indexed.

The one limitation: Transfer logs require an RPC that supports `eth_getLogs` with a wide block range. Public endpoints sometimes restrict this. A paid RPC removes the restriction.

---

## The guard daemon

Claiming is the active case — you know a reward is available, you run the rescue. But there's a passive case: airdrops that arrive without warning.

INK tokens. BASE network tokens. Any future airdrop to an address with history.

For this, the tool includes a guard mode: a daemon that runs continuously, watches for incoming transfers, and sweeps immediately.

The architecture is straightforward. The wallet stays permanently delegated to the `Rescuer` contract. The daemon uses viem's `watchEvent` to subscribe to Transfer events in real time — no polling lag. When an event arrives with `to == compromised address`, it triggers `sweepAll` immediately.

```typescript
watchIncomingTransfers(client, source.address, (tokenAddress) => {
    // A transfer just arrived. Sweep everything now.
    doSweep({ ...opts, newToken: tokenAddress });
});
```

ETH is handled separately — `watchEvent` only catches ERC-20 transfers. A 15-second polling interval covers native token arrivals.

The delegation is checked every 10 minutes and automatically restored if it has been reset. This matters because certain actions on the wallet (including some claim transactions) reset the EIP-7702 authorization to zero.

---

## Preparing a claim

For active claims, the tool uses JSON config files. Each file describes one claimable reward:

```json
{
  "name": "Layer3 Claim",
  "network": "base",
  "contract": "0x...claim contract address...",
  "data": "0x...calldata...",
  "hint_tokens": ["0x...token address..."]
}
```

`contract` and `data` come from MetaMask. Open the claim page, connect the compromised wallet, click Claim — but don't confirm. MetaMask shows you the transaction it would send: the `To` address and the `Data` field. Copy them. Cancel without confirming. Paste into the config.

`hint_tokens` is optional. The tool discovers tokens automatically through Transfer logs. But if you already know what's coming — WPLUME in addition to PLUME, for example — listing it here costs nothing and ensures coverage even if the Transfer log scan misses something.

Then:

```bash
# Verify without sending anything
npx tsx src/index.ts rescue base --claim claims/l3.json --dry-run

# Execute
npx tsx src/index.ts rescue base --claim claims/l3.json
```

The dry-run simulates the full flow — delegation, contract resolution, calldata encoding, gas estimation — without broadcasting. It's the right first step whenever you're working with a claim you haven't tested before.

---

## Adding a network takes one file edit

The previous tools in this series supported a fixed network list. The rescue tool is built to expand.

Adding a network is a single entry in `src/networks.ts`:

```typescript
plume: defineChain({
  id: 98866,
  name: "Plume",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.plumenetwork.xyz"] } },
  blockExplorers: { default: { name: "Plume Explorer", url: "https://explorer.plumenetwork.xyz" } },
}),
```

Every command — `rescue`, `guard`, `scan`, `deploy` — picks it up automatically. The network list is the single source of truth.

---

## How the Rescuer contract stays stateless

One architectural choice worth explaining: the `Rescuer` contract stores nothing. No `destination` address. No owner. No mappings.

Everything is passed as calldata on every invocation. This means:

- The same deployed contract can be used by anyone for any destination.
- There's no storage slot an attacker can manipulate.
- The contract can be verified trivially — it has no state to audit.

If `RESCUER_BASE=0x...` is set in `.env`, the tool reuses that deployment instead of deploying a new contract each run. Shared, stateless, verifiable.

---

## The three tools, one ecosystem

This is now the third tool in what has become a small ecosystem around compromised wallet recovery:

**EIP-7702 Revoker** handles the case where your wallet is delegated to something malicious. One command clears the delegation across all chains. The web version does it in a browser with no install.

**Auto-Forwarder** is the always-on protection layer. The wallet stays delegated to a trusted forwarder contract that automatically routes everything to a safe destination.

**EIP-7702 Rescue Tool** is the active rescue layer. Atomic claim + sweep for known rewards. 24/7 guard daemon for surprise airdrops.

The tools compose. If a rescue fails because the bot was faster, the guard daemon is already running with the delegation maintained — the next thing that arrives gets swept automatically. Revocation, forwarding, and active rescue cover different phases of the same problem.

---

## What I'd do differently for Plume

With this tool, the Plume rescue would have looked like:

```json
{
  "name": "Plume Hedgey",
  "network": "plume",
  "contract": "0x...hedgey on plume...",
  "data": "0x...calldata...",
  "hint_tokens": [
    "0x...PLUME...",
    "0x...WPLUME...",
    "0x...pUSD..."
  ]
}
```

```bash
npx tsx src/index.ts rescue plume --claim claims/plume-hedgey.json
```

One transaction. Claim executes. All three tokens swept in the same block. The bot finds an empty wallet.

That's the difference between two transactions and one.

---

## The source

The tool is MIT licensed, no external services, no telemetry.

**GitHub:** [github.com/Serge693/eip7702-rescue](https://github.com/Serge693/eip7702-rescue)

**Telegram:** [@Sergio6967](https://t.me/Sergio6967)

---

## The full series

- Part 1 — [Your Wallet Was Hacked. Now You Can't Even Afford to Fix It.](https://medium.com/@skartanenkov/your-wallet-was-hacked-now-you-cant-even-afford-to-fix-it-7e1b624ec380)
- Part 2 — [From CLI to Web: Building a Sponsored EIP-7702 Revocation Service](https://medium.com/@skartanenkov/from-cli-to-web-building-a-sponsored-eip-7702-revocation-service-172b393a381b)
- Part 3 — [How EIP-7702 Revoker Compares to Existing Tools](https://medium.com/@skartanenkov/how-eip-7702-revoker-compares-to-existing-tools-39d0f0bfe2b7)
- Part 4 — [The Browser Extension That Fixes What dApps Can't](https://medium.com/@skartanenkov/the-browser-extension-that-fixes-what-dapps-cant-eip-7702-revocation-without-a-server-cfff1dcf6049)
- Part 5 — [It's Live: EIP-7702 Revoker Is Now a Public Web Service](https://medium.com/@skartanenkov/its-live-eip-7702-revoker-is-now-a-public-web-service-579472f8f034)
- **Part 6 — When Revoking Isn't Enough** ← you are here
