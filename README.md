# EIP-7702 Rescue Tool

**English** | [Русский](#русский)

---

## English

### What is this?

A tool to rescue funds from a **compromised (hacked) wallet** using EIP-7702 — a special Ethereum feature that lets your wallet temporarily behave like a smart contract.

**The problem this solves:**

Your wallet's private key was stolen. A sweeper bot now watches your address 24/7 and instantly grabs anything that arrives — airdrops, vesting unlocks, claim rewards. You can't outrun it manually: it reacts in under 2 seconds.

**How this tool beats the bot:**

It combines **claim + transfer into a single atomic transaction**. The tokens never sit in the compromised wallet — they arrive and leave in the same block. The bot has no window to react.

```
Without this tool:           With this tool:
  tx 1: claim()                tx 1: claim() + sweepAll()
    ↓ tokens arrive                   ↓ tokens go straight to you
  BOT GRABS THEM              Bot has nothing to grab
  tx 2: your transfer()
    ↓ too late
```

### Real example of why atomicity matters

During a Plume rescue, claim and transfer were two separate transactions. The sweeper bot grabbed 451 WPLUME in 2 seconds — before the second transaction could execute. This tool was built to prevent exactly that.

---

### Requirements

- Node.js 18 or newer ([download](https://nodejs.org))
- Three wallets:
  - **Source** — the compromised wallet (you have the private key)
  - **Sponsor** — a clean wallet with ETH to pay for gas
  - **Destination** — a safe wallet to receive rescued funds

---

### Installation

```bash
git clone https://github.com/your-username/eip7702-rescue
cd eip7702-rescue
npm install
cp .env.example .env
```

Open `.env` in any text editor and fill in:

```env
SOURCE_PRIVATE_KEY=0x...       # Private key of the compromised wallet
SPONSOR_PRIVATE_KEY=0x...      # Private key of the wallet that pays gas
DESTINATION_ADDRESS=0x...      # Address of your safe wallet (public address, not private key)
```

---

### First-time setup

**Step 1 — Compile the smart contract**

```bash
npm run compile
```

This compiles `contracts/Rescuer.sol` and automatically patches the bytecode into the source code. You only do this once.

**Step 2 — Deploy the Rescuer contract**

```bash
npx tsx src/index.ts deploy base       # deploy on Base
npx tsx src/index.ts deploy ethereum   # deploy on Ethereum
npx tsx src/index.ts deploy            # deploy on all networks
```

After deployment, copy the printed address into `.env`:

```env
RESCUER_BASE=0x...the address you got...
```

This saves gas on future rescues — the contract is reused instead of redeployed each time.

---

### Commands

#### `scan` — check what's on the compromised wallet

```bash
npx tsx src/index.ts scan              # all networks
npx tsx src/index.ts scan base         # Base only
```

Shows ETH and token balances. Does not send any transactions.

---

#### `rescue` — one-shot atomic rescue

Use when you know a specific claim is ready (vesting unlock, airdrop, L3 reward, etc.).

```bash
# Dry run first — simulates everything without sending transactions
npx tsx src/index.ts rescue base --claim claims/l3.json --dry-run

# Execute for real
npx tsx src/index.ts rescue base --claim claims/l3.json

# Sweep only (no claim — for tokens already sitting on the wallet)
npx tsx src/index.ts rescue base
```

What happens under the hood:
1. Discovers all tokens ever sent to the compromised address (via Transfer logs)
2. Deploys or reuses the Rescuer contract
3. Sends one atomic EIP-7702 transaction: `claim() + sweepAll()`
4. Revokes the delegation after completion

---

#### `guard` — 24/7 daemon for incoming airdrops

Use when you're waiting for an airdrop that could arrive any time (INK tokens, BASE tokens, etc.) and you don't know exactly when or how.

```bash
npx tsx src/index.ts guard base        # watch Base only
npx tsx src/index.ts guard             # watch all networks
```

What it does:
- Keeps the wallet permanently delegated to the Rescuer contract
- Watches for any incoming ERC-20 Transfer event in real time
- Polls for ETH balance every 15 seconds
- On detection: immediately sweeps everything to destination
- If delegation is lost (e.g. the wallet did something): automatically restores it
- Checks delegation every 10 minutes as a safety net

Keep it running in a terminal (or on a server) until all expected airdrops have arrived.

---

#### `deploy` — deploy the Rescuer contract

```bash
npx tsx src/index.ts deploy base
npx tsx src/index.ts deploy            # all networks
```

---

### Claim configs

To claim a specific reward (L3, OFC, Hedgey vesting, etc.), you need a claim config file.

See **`claims/HOW-TO-GET-CALLDATA.md`** for step-by-step instructions on how to prepare one.

Quick format reference:

```json
{
  "name": "My Claim",
  "network": "base",
  "contract": "0x...claim contract address...",
  "data": "0x...calldata...",
  "hint_tokens": ["0x...token address..."]
}
```

- `contract` — the "To" address from MetaMask when you click Claim (do NOT confirm in MetaMask)
- `data` — the "Data" field from MetaMask
- `hint_tokens` — token addresses you expect to receive (optional, tool auto-discovers anyway)

---

### Adding a new network

Open `src/networks.ts` and add an entry:

```ts
mynetwork: defineChain({
  id: 12345,
  name: "My Network",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mynetwork.io"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.mynetwork.io" } },
}),
```

Then:
```bash
npx tsx src/index.ts deploy mynetwork
# Add RESCUER_MYNETWORK=0x... to .env
```

All other commands (`rescue`, `guard`, `scan`) automatically pick up the new network.

---

### `.env` full reference

```env
# ── Required ──────────────────────────────────────────────────────────────────
SOURCE_PRIVATE_KEY=0x...        # Compromised wallet private key
SPONSOR_PRIVATE_KEY=0x...       # Gas-paying wallet private key
DESTINATION_ADDRESS=0x...       # Safe destination (public address only)

# ── Pre-deployed Rescuer contracts (fill after running deploy) ────────────────
RESCUER_BASE=
RESCUER_ETHEREUM=
RESCUER_INK=
RESCUER_ARBITRUM=
RESCUER_OPTIMISM=
RESCUER_POLYGON=

# ── Custom RPCs (optional but recommended for guard mode) ─────────────────────
RPC_URL_BASE=
RPC_URL_ETHEREUM=

# ── Tuning ────────────────────────────────────────────────────────────────────
SPONSOR_MIN_BALANCE=0.005       # Warn if sponsor balance drops below this (ETH)
DRY_RUN=false                   # Set to true to simulate without sending
```

---

### Lessons from the Plume incident

- **Atomicity is everything.** Two separate transactions (claim, then transfer) will lose to a professional sweeper bot that reacts in 2 seconds. Always use this tool's atomic mode.
- **You don't always know what token will arrive.** The Plume claim returned WPLUME instead of PLUME. The tool now sweeps ALL tokens with non-zero balance — not just the one you expected.
- **Read `hint_tokens` seriously.** Add every possible token variant (wrapped, unwrapped, stablecoin) to the claim config. Extra entries cost almost nothing; missing one loses everything.

---

---

## Русский

### Что это такое?

Инструмент для спасения средств со **скомпрометированного (взломанного) кошелька** с помощью EIP-7702 — специальной функции Ethereum, которая позволяет твоему кошельку временно работать как смарт-контракт.

**Какую проблему решает:**

Приватный ключ твоего кошелька украден. Бот-свипер теперь следит за твоим адресом 24/7 и мгновенно забирает всё что туда приходит — аирдропы, разлоки вестинга, награды за клеймы. Вручную его не обогнать: он реагирует менее чем за 2 секунды.

**Как этот инструмент обходит бота:**

Объединяет **клейм + перевод в одну атомарную транзакцию**. Токены никогда не задерживаются в скомпрометированном кошельке — они приходят и уходят в одном блоке. У бота нет окна для реакции.

```
Без этого инструмента:       С этим инструментом:
  tx 1: claim()                tx 1: claim() + sweepAll()
    ↓ токены пришли                   ↓ токены сразу у тебя
  БОТ ЗАБИРАЕТ ВСЁ            Боту нечего забирать
  tx 2: твой перевод()
    ↓ слишком поздно
```

### Реальный пример почему атомарность важна

При спасении Plume клейм и перевод были двумя отдельными транзакциями. Бот-свипер забрал 451 WPLUME за 2 секунды — до того как успела выполниться вторая транзакция. Этот инструмент создан именно для того чтобы такого не повторилось.

---

### Что нужно для работы

- Node.js 18 или новее ([скачать](https://nodejs.org/ru))
- Три кошелька:
  - **Source (скомпрометированный)** — взломанный кошелёк, от которого у тебя есть приватный ключ
  - **Sponsor (спонсор)** — чистый кошелёк с ETH для оплаты газа
  - **Destination (назначение)** — безопасный кошелёк куда придут спасённые средства

---

### Установка

```bash
git clone https://github.com/your-username/eip7702-rescue
cd eip7702-rescue
npm install
cp .env.example .env
```

Открой файл `.env` в любом текстовом редакторе и заполни:

```env
SOURCE_PRIVATE_KEY=0x...       # Приватный ключ скомпрометированного кошелька
SPONSOR_PRIVATE_KEY=0x...      # Приватный ключ кошелька который платит за газ
DESTINATION_ADDRESS=0x...      # Адрес безопасного кошелька (публичный адрес, не приватный ключ)
```

---

### Первый запуск (делается один раз)

**Шаг 1 — Скомпилировать смарт-контракт**

```bash
npm run compile
```

Компилирует `contracts/Rescuer.sol` и автоматически вставляет байткод в исходный код. Делается один раз.

**Шаг 2 — Задеплоить контракт Rescuer**

```bash
npx tsx src/index.ts deploy base       # задеплоить на Base
npx tsx src/index.ts deploy ethereum   # задеплоить на Ethereum
npx tsx src/index.ts deploy            # задеплоить на все сети
```

После деплоя скопируй напечатанный адрес в `.env`:

```env
RESCUER_BASE=0x...полученный адрес...
```

Это экономит газ при последующих rescue — контракт переиспользуется вместо повторного деплоя.

---

### Команды

#### `scan` — посмотреть что есть на скомпрометированном кошельке

```bash
npx tsx src/index.ts scan              # все сети
npx tsx src/index.ts scan base         # только Base
```

Показывает балансы ETH и токенов. Транзакции не отправляет.

---

#### `rescue` — разовое атомарное спасение

Используй когда знаешь что конкретный клейм готов (разлок вестинга, аирдроп, награда L3 и т.д.).

```bash
# Сначала сделай dry run — симулирует всё без отправки транзакций
npx tsx src/index.ts rescue base --claim claims/l3.json --dry-run

# Запустить по-настоящему
npx tsx src/index.ts rescue base --claim claims/l3.json

# Только sweep (без клейма — если токены уже лежат на кошельке)
npx tsx src/index.ts rescue base
```

Что происходит под капотом:
1. Находит все токены которые когда-либо приходили на скомпрометированный адрес (через Transfer логи)
2. Деплоит или переиспользует контракт Rescuer
3. Отправляет одну атомарную EIP-7702 транзакцию: `claim() + sweepAll()`
4. После завершения отзывает делегацию

---

#### `guard` — демон 24/7 для входящих аирдропов

Используй когда ждёшь аирдроп который может прийти в любой момент (токены INK, BASE и т.д.) и не знаешь точно когда и как.

```bash
npx tsx src/index.ts guard base        # следить только за Base
npx tsx src/index.ts guard             # следить за всеми сетями
```

Что делает:
- Держит кошелёк постоянно делегированным на контракт Rescuer
- Следит за входящими ERC-20 Transfer событиями в реальном времени
- Каждые 15 секунд проверяет баланс ETH
- При обнаружении: немедленно выметает всё на destination
- Если делегация слетела: автоматически восстанавливает её
- Каждые 10 минут проверяет делегацию на всякий случай

Оставь запущенным в терминале (или на сервере) пока не придут все ожидаемые аирдропы.

---

#### `deploy` — задеплоить контракт Rescuer

```bash
npx tsx src/index.ts deploy base
npx tsx src/index.ts deploy            # все сети
```

---

### Конфиги клеймов

Для клейма конкретной награды (L3, OFC, Hedgey вестинг и т.д.) нужен файл конфига.

Читай **`claims/HOW-TO-GET-CALLDATA.md`** — там пошаговая инструкция как его подготовить.

Краткий формат:

```json
{
  "name": "Мой клейм",
  "network": "base",
  "contract": "0x...адрес контракта клейма...",
  "data": "0x...calldata...",
  "hint_tokens": ["0x...адрес токена..."]
}
```

- `contract` — адрес "To" из MetaMask когда нажимаешь Claim (НЕ подтверждай в MetaMask)
- `data` — поле "Data" из MetaMask
- `hint_tokens` — адреса токенов которые ожидаешь получить (необязательно, инструмент сам находит)

---

### Добавление новой сети

Открой `src/networks.ts` и добавь запись:

```ts
mynetwork: defineChain({
  id: 12345,
  name: "My Network",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mynetwork.io"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.mynetwork.io" } },
}),
```

Потом:
```bash
npx tsx src/index.ts deploy mynetwork
# Добавь RESCUER_MYNETWORK=0x... в .env
```

Остальные команды (`rescue`, `guard`, `scan`) подхватят новую сеть автоматически.

---

### Полный список переменных `.env`

```env
# ── Обязательные ──────────────────────────────────────────────────────────────
SOURCE_PRIVATE_KEY=0x...        # Приватный ключ скомпрометированного кошелька
SPONSOR_PRIVATE_KEY=0x...       # Приватный ключ кошелька-спонсора (платит газ)
DESTINATION_ADDRESS=0x...       # Безопасный адрес назначения (только публичный!)

# ── Задеплоенные контракты (заполняй после deploy) ────────────────────────────
RESCUER_BASE=
RESCUER_ETHEREUM=
RESCUER_INK=
RESCUER_ARBITRUM=
RESCUER_OPTIMISM=
RESCUER_POLYGON=

# ── Кастомные RPC (необязательно, но рекомендуется для guard) ─────────────────
RPC_URL_BASE=
RPC_URL_ETHEREUM=

# ── Настройка ─────────────────────────────────────────────────────────────────
SPONSOR_MIN_BALANCE=0.005       # Предупреждение если баланс спонсора ниже (ETH)
DRY_RUN=false                   # true = симуляция без отправки транзакций
```

---

### Уроки из инцидента с Plume

- **Атомарность — это всё.** Две отдельные транзакции (клейм, потом перевод) проигрывают профессиональному боту который реагирует за 2 секунды. Всегда используй атомарный режим этого инструмента.
- **Ты не всегда знаешь какой токен придёт.** Клейм Plume вернул WPLUME вместо PLUME. Инструмент теперь выметает ВСЕ токены с ненулевым балансом — не только ожидаемые.
- **Серьёзно относись к `hint_tokens`.** Добавляй все возможные варианты токена (wrapped, unwrapped, стейблкоин). Лишние записи почти ничего не стоят, пропущенная запись стоит всего.
