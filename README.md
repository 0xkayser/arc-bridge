# arc-bridge

Минимальный open-source flow для USDC:

`Base wallet → approve → GatewayWallet.deposit → Gateway finality → estimate → EIP-712 → forwarded transfer → Arc`

## Что здесь есть

- `web/` — простая self-custody страница: пользователь подключает свой кошелёк, нажимает `Approve`, затем `Deposit`.
- `bridge.js` — CLI для проверки депозита, ожидания Gateway и forwarded transfer.
- Приватные ключи не сохраняются и не отправляются на сервер.
- Для forwarded transfer не нужен USDC на Arc для газа: Circle сам отправляет mint-транзакцию на destination.

## Web deposit

Открой локально через HTTP-сервер (кошелёк обычно блокирует `file://`):

```bash
cd ~/Desktop/arc-bridge
python3 -m http.server 8080 --directory web
```

Открой [http://localhost:8080](http://localhost:8080), подключи кошелёк на Base и выполни:

1. `Approve USDC` — approve на точную сумму.
2. `Deposit to Gateway` — `GatewayWallet.deposit(USDC, amount)`.

После deposit Gateway ждёт финалити Base. Для Base это обычно около 13–19 минут. Не отправляй USDC обычным ERC-20 `transfer` прямо на GatewayWallet: такой перевод не создаёт Gateway-баланс.

После merge workflow GitHub Pages страницу можно открыть по адресу:
`https://0xkayser.github.io/arc-bridge/`.

## CLI

```bash
npm install

# read-only диагностика
PRIVATE_KEY=0x... node bridge.js balance
PRIVATE_KEY=0x... node bridge.js diagnose

# 1. approve (если allowance недостаточен) + deposit на Base
PRIVATE_KEY=0x... node bridge.js deposit 25

# 2. ждать, пока Gateway увидит депозит
PRIVATE_KEY=0x... node bridge.js wait 25

# 3. estimate → подпись burn intent → forwarded transfer → polling
PRIVATE_KEY=0x... node bridge.js transfer 25
```

Для автоматического подтверждения on-chain транзакций можно добавить `--yes`:

```bash
PRIVATE_KEY=0x... node bridge.js deposit 25 --yes
PRIVATE_KEY=0x... node bridge.js transfer 25 --yes
```

CLI не использует ручной `MAX_FEE`: fee и `maxBlockHeight` берутся из `/v1/estimate?enableForwarder=true`. `destinationToken` не угадывается: код читает его из Gateway API; если API ещё не публикует адрес, transfer останавливается до подписи.

## Важное ограничение

На момент последней проверки live mainnet Gateway API Circle не возвращал активную сеть домена `26` (Arc) в `/v1/info`. Поэтому deposit на Base уже можно делать, но CLI не будет подписывать и отправлять нерабочий transfer, пока Circle не активирует Arc mainnet. Arc Testnet и mainnet — разные Gateway API окружения и адреса.

## Контракты mainnet Base

- GatewayWallet: `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`
- Base USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- GatewayMinter: `0x2222222d7164433c4C09B0b0D809a9b52C04C205`
- Gateway API: `https://gateway-api.circle.com/v1`

## License

MIT. См. [LICENSE](./LICENSE).
