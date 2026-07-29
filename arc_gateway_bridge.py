#!/usr/bin/env python3
"""
Bridge USDC from Base to Arc mainnet via Circle Gateway.

Flow: deposit on Base -> Gateway finality -> signed BurnIntent ->
Circle attestation -> gatewayMint on Arc.

Operational notes:
  - Arc mainnet is exposed through the Gateway API with the
    X-ARC-PRIVATE-MAINNET-ENABLED: true feature header.
  - The live fee and expiry are read from /estimate; no fee is hard-coded.
  - The API requires integer JSON fields to be strings and TransferSpec addresses
    to be bytes32 values. The script normalizes both formats.
  - The Forwarder may be unavailable, so self-mint is the default. Keep USDC on
    Arc for gas, or use --calldata and ask a trusted relayer to submit the mint.
  - Attestations expire quickly and the Gateway balance is debited when the
    attestation is issued. Do not pause between bridge and mint.
  - Private keys are read only from PRIVKEY and are never written to disk.

Install: python -m pip install -r requirements.txt
Usage: python arc_gateway_bridge.py balance
       python arc_gateway_bridge.py bridge --amount 100 --yes

MIT licensed. Verify amounts and destinations before signing.
"""
import argparse, json, os, secrets, sys, time
import urllib.request, urllib.error

from eth_account import Account
from eth_account.messages import encode_typed_data

# ---------------- network ----------------
GATEWAY_API = "https://gateway-api.circle.com/v1"
BASE_RPCS = [os.environ.get("BASE_RPC")] if os.environ.get("BASE_RPC") else [
    "https://base.drpc.org",          # самый стабильный из бесплатных на отправку
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
]
ARC_RPCS = [os.environ.get("ARC_RPC")] if os.environ.get("ARC_RPC") else [
    "https://5042.rpc.thirdweb.com",
    "https://rpc.blockdaemon.mainnet.arc.io",
]

USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
USDC_ARC = "0x3600000000000000000000000000000000000000"   # на Arc USDC — нативный газ-токен
GATEWAY_WALLET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE"
GATEWAY_MINTER = "0x2222222d7164433c4C09B0b0D809a9b52C04C205"
DOMAIN_BASE, DOMAIN_ARC = 6, 26
CHAIN_BASE, CHAIN_ARC = 8453, 5042

SEL_DEPOSIT = "0x47e7ef24"        # deposit(address token, uint256 value)
SEL_APPROVE = "0x095ea7b3"        # approve(address,uint256)
SEL_ALLOWANCE = "0xdd62ed3e"
SEL_BALANCEOF = "0x70a08231"
SEL_GATEWAY_MINT = "0x9fb01cc5"   # gatewayMint(bytes attestation, bytes signature)

MIN_BLOCK_WINDOW = 302_400        # минимальный срок жизни burn intent
FINALITY_BLOCKS = 640             # ~13-21 минута на Base

HTTP = {"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"}
GW_HTTP = {**HTTP, "X-ARC-PRIVATE-MAINNET-ENABLED": "true"}   # см. пункт 1
STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "arc_gateway_state.json")

EIP712_TYPES = {
    "TransferSpec": [
        {"name": "version", "type": "uint32"},
        {"name": "sourceDomain", "type": "uint32"},
        {"name": "destinationDomain", "type": "uint32"},
        {"name": "sourceContract", "type": "bytes32"},
        {"name": "destinationContract", "type": "bytes32"},
        {"name": "sourceToken", "type": "bytes32"},
        {"name": "destinationToken", "type": "bytes32"},
        {"name": "sourceDepositor", "type": "bytes32"},
        {"name": "destinationRecipient", "type": "bytes32"},
        {"name": "sourceSigner", "type": "bytes32"},
        {"name": "destinationCaller", "type": "bytes32"},
        {"name": "value", "type": "uint256"},
        {"name": "salt", "type": "bytes32"},
        {"name": "hookData", "type": "bytes"},
    ],
    "BurnIntent": [
        {"name": "maxBlockHeight", "type": "uint256"},
        {"name": "maxFee", "type": "uint256"},
        {"name": "spec", "type": "TransferSpec"},
    ],
}

pad32 = lambda a: "0x" + a.lower().replace("0x", "").rjust(64, "0")
word = lambda n: hex(n)[2:].rjust(64, "0")


def log(m): print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)
def die(m): log(f"✗ {m}"); sys.exit(1)


def account():
    pk = os.environ.get("PRIVKEY")
    if not pk:
        die("не задан PRIVKEY: export PRIVKEY=0x...")
    return Account.from_key(pk)


def gw_api(path, payload):
    """Запрос к Gateway API. Всегда с заголовком приватного мейннета."""
    req = urllib.request.Request(GATEWAY_API + path,
                                 data=json.dumps(payload).encode(), headers=GW_HTTP)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"httpError": e.code}
    except Exception as e:
        return {"netError": str(e)[:120]}


def save_state(**values):
    """Сохраняет одноразовую attestation локально, без приватного ключа."""
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(values, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, STATE)


def rpc(rpcs, method, params, tries=2):
    """JSON-RPC с перебором нод: одна нода часто отваливается (см. пункт 7)."""
    for url in rpcs:
        for _ in range(tries):
            try:
                req = urllib.request.Request(url, data=json.dumps(
                    {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}).encode(),
                    headers=HTTP)
                with urllib.request.urlopen(req, timeout=40) as r:
                    j = json.loads(r.read())
                if "error" not in j:
                    return j.get("result")
            except Exception:
                time.sleep(1)
    return None


def send_raw(rpcs, raw_hex):
    """Отправка подписанной транзакции с перебором нод.
    Одна и та же подпись идемпотентна: повторная отправка не создаст вторую tx."""
    for url in rpcs:
        try:
            req = urllib.request.Request(url, data=json.dumps(
                {"jsonrpc": "2.0", "method": "eth_sendRawTransaction",
                 "params": [raw_hex], "id": 1}).encode(), headers=HTTP)
            with urllib.request.urlopen(req, timeout=40) as r:
                j = json.loads(r.read())
            if "result" in j:
                return j["result"], url
            err = str(j.get("error", ""))
            if "already known" in err or "nonce too low" in err:
                return None, "already-in-mempool"
            log(f"  {url}: {err[:110]}")
        except Exception as e:
            log(f"  {url}: сеть — {str(e)[:70]}")
    return None, None


def build_and_send(rpcs, acct, chain_id, to, data, label, tip_wei, dry=False):
    nonce = rpc(rpcs, "eth_getTransactionCount", [acct.address, "latest"])
    blk = rpc(rpcs, "eth_getBlockByNumber", ["latest", False])
    gas_hex = rpc(rpcs, "eth_estimateGas", [{"from": acct.address, "to": to, "data": data}])
    if not (nonce and blk and gas_hex):
        die(f"{label}: не удалось подготовить транзакцию (RPC не отвечает)")
    base_fee = int(blk.get("baseFeePerGas", "0x0"), 16)
    tx = {"to": to, "data": data, "value": 0, "chainId": chain_id, "type": 2,
          "nonce": int(nonce, 16), "gas": int(int(gas_hex, 16) * 1.4),
          "maxPriorityFeePerGas": tip_wei, "maxFeePerGas": base_fee * 3 + tip_wei}
    log(f"  {label}: газ {tx['gas']:,}, потолок {tx['gas']*tx['maxFeePerGas']/1e18:.8f}")
    if dry:
        log("  (пробный расчёт, отправки не было)")
        return None
    h, via = send_raw(rpcs, acct.sign_transaction(tx).raw_transaction.hex())
    if via == "already-in-mempool":
        log("  транзакция уже в сети")
    elif not h:
        die(f"{label}: отправить не удалось. ПРОВЕРЬТЕ nonce и баланс прежде чем повторять")
    else:
        log(f"  отправлено: {h}")
    if not h:
        return None
    for _ in range(60):
        r = rpc(rpcs, "eth_getTransactionReceipt", [h])
        if isinstance(r, dict) and r.get("status") is not None:
            ok = int(r["status"], 16) == 1
            log(f"  {'✓ успех' if ok else '✗ реверт'} — блок {int(r['blockNumber'],16)}, "
                f"газ {int(r['gasUsed'],16):,}")
            return r if ok else die(f"{label} завершилась ревертом")
        time.sleep(3)
    die(f"{label}: не дождался подтверждения (проверьте {h} вручную)")


def gateway_balance(addr):
    r = gw_api("/balances", {"token": "USDC",
                             "sources": [{"domain": DOMAIN_BASE, "depositor": addr}]})
    try:
        b = r["balances"][0]
        return int(round(float(b["balance"]) * 1e6)), b
    except Exception:
        return 0, r


def make_spec(acct, value, recipient, any_caller=True):
    spec = {
        "version": 1,
        "sourceDomain": DOMAIN_BASE,
        "destinationDomain": DOMAIN_ARC,
        "sourceContract": pad32(GATEWAY_WALLET),
        "destinationContract": pad32(GATEWAY_MINTER),
        "sourceToken": pad32(USDC_BASE),
        "destinationToken": pad32(USDC_ARC),
        "sourceDepositor": pad32(acct.address),
        "destinationRecipient": pad32(recipient),
        "sourceSigner": pad32(acct.address),
        # нули => подать минт может кто угодно; получатель всё равно зашит выше
        "destinationCaller": pad32("0x" + "0" * 40) if any_caller else pad32(acct.address),
        "value": value,
        "salt": "0x" + secrets.token_hex(32),
        "hookData": "0x",
    }
    return spec


def estimate_self_mint(spec):
    """Берёт fee и срок жизни burn intent у Circle; ничего не подписывает."""
    # Gateway API сериализует uint256 через stringifyTypedData: value должен
    # приехать JSON-строкой, иначе сервер трактует запрос не как PartialBurnIntent.
    request_spec = {**spec, "value": str(spec["value"])}
    res = gw_api("/estimate", [{"spec": request_spec}])
    try:
        intent = res[0]["burnIntent"]
        canonical = intent["spec"]
        max_fee = int(intent["maxFee"])
        max_block = int(intent["maxBlockHeight"])
    except Exception:
        die(f"Circle estimate не вернул burnIntent: {json.dumps(res, ensure_ascii=False)[:400]}")
    if max_block <= 0 or max_fee < 0 or not canonical:
        die("Circle estimate вернул некорректный burnIntent")
    # Estimate отвечает адресами в 20-byte формате, а signed transfer требует
    # все адресные поля TransferSpec в bytes32. Нормализуем перед подписью.
    for field in (
        "sourceContract", "destinationContract", "sourceToken", "destinationToken",
        "sourceDepositor", "destinationRecipient", "sourceSigner", "destinationCaller",
    ):
        if field in canonical:
            canonical[field] = pad32(canonical[field])
    return {
        "maxBlockHeight": max_block,
        "maxFee": max_fee,
        "spec": {**canonical, "value": int(canonical["value"])},
    }


def sign_burn_intent(acct, intent):
    """Подписывает именно canonical burnIntent, который вернул Circle."""
    typed = {
        "maxBlockHeight": int(intent["maxBlockHeight"]),
        "maxFee": int(intent["maxFee"]),
        "spec": {**intent["spec"], "value": int(intent["spec"]["value"])},
    }
    signable = encode_typed_data(
        domain_data={"name": "GatewayWallet", "version": "1"},   # без chainId!
        message_types=EIP712_TYPES, message_data=typed)
    signed = acct.sign_message(signable)
    if Account.recover_message(signable, signature=signed.signature).lower() != acct.address.lower():
        die("подпись не восстанавливается — структура EIP-712 неверна")
    # в JSON числа строками, подпись с 0x (см. пункт 4)
    wire = {"maxBlockHeight": str(typed["maxBlockHeight"]),
            "maxFee": str(typed["maxFee"]),
            "spec": {**typed["spec"], "value": str(typed["spec"]["value"])}}
    return wire, "0x" + signed.signature.hex().replace("0x", "")


def mint_calldata(attestation, signature):
    def enc(h):
        raw = bytes.fromhex(h.replace("0x", ""))
        return len(raw), raw + b"\x00" * ((32 - len(raw) % 32) % 32)
    la, da = enc(attestation)
    ls, ds = enc(signature or "0x")
    head = (64).to_bytes(32, "big") + (64 + 32 + len(da)).to_bytes(32, "big")
    return SEL_GATEWAY_MINT + (head + la.to_bytes(32, "big") + da +
                               ls.to_bytes(32, "big") + ds).hex()


# ---------------- команды ----------------

def cmd_balance(args):
    a = account()
    log(f"адрес {a.address}")
    u = rpc(BASE_RPCS, "eth_call", [{"to": USDC_BASE,
            "data": SEL_BALANCEOF + pad32(a.address)[2:]}, "latest"])
    e = rpc(BASE_RPCS, "eth_getBalance", [a.address, "latest"])
    al = rpc(BASE_RPCS, "eth_call", [{"to": USDC_BASE,
            "data": SEL_ALLOWANCE + pad32(a.address)[2:] + pad32(GATEWAY_WALLET)[2:]}, "latest"])
    log(f"  Base: USDC {int(u or '0x0',16)/1e6:,.6f} | ETH {int(e or '0x0',16)/1e18:.8f} "
        f"| allowance {int(al or '0x0',16)/1e6:,.2f}")
    avail, raw = gateway_balance(a.address)
    log(f"  Gateway: доступно {avail/1e6:,.6f}"
        + (f" | в обработке {raw.get('pendingBatch')}" if isinstance(raw, dict) and raw.get('pendingBatch') else ""))
    d = gw_api("/deposits", {"token": "USDC", "sources": [{"domain": DOMAIN_BASE, "depositor": a.address}]})
    for x in (d.get("deposits") or []):
        log(f"    депозит {int(x['amount'])/1e6:,.2f} — {x['status']} (блок {x['blockHeight']})")
    g = rpc(ARC_RPCS, "eth_getBalance", [a.address, "latest"])
    log(f"  Arc: {int(g or '0x0',16)/1e18:,.6f} USDC (это и газ, и баланс)")


def cmd_deposit(args):
    a = account()
    amount = int(round(args.amount * 1e6))
    u = int(rpc(BASE_RPCS, "eth_call", [{"to": USDC_BASE,
             "data": SEL_BALANCEOF + pad32(a.address)[2:]}, "latest"]) or "0x0", 16)
    if u < amount:
        die(f"на Base только {u/1e6:,.6f} USDC, нужно {amount/1e6:,.6f}")
    al = int(rpc(BASE_RPCS, "eth_call", [{"to": USDC_BASE,
              "data": SEL_ALLOWANCE + pad32(a.address)[2:] + pad32(GATEWAY_WALLET)[2:]}, "latest"]) or "0x0", 16)
    if al < amount:
        log("approve USDC для GatewayWallet")
        build_and_send(BASE_RPCS, a, CHAIN_BASE, USDC_BASE,
                       SEL_APPROVE + pad32(GATEWAY_WALLET)[2:] + word(amount),
                       "approve", 2_000_000, dry=not args.yes)
        if not args.yes:
            log("добавьте --yes, чтобы выполнить approve и deposit"); return
    else:
        log(f"approve не нужен (allowance {al/1e6:,.2f})")
    log(f"deposit {amount/1e6:,.6f} USDC в GatewayWallet")
    sim = rpc(BASE_RPCS, "eth_call", [{"from": a.address, "to": GATEWAY_WALLET,
              "data": SEL_DEPOSIT + pad32(USDC_BASE)[2:] + word(amount)}, "latest"])
    if sim is None:
        die("симуляция deposit не прошла — проверьте allowance и баланс")
    r = build_and_send(BASE_RPCS, a, CHAIN_BASE, GATEWAY_WALLET,
                       SEL_DEPOSIT + pad32(USDC_BASE)[2:] + word(amount),
                       "deposit", 2_000_000, dry=not args.yes)
    if r:
        log(f"депозит в блоке {int(r['blockNumber'],16)}. Circle учтёт его "
            f"через ~{FINALITY_BLOCKS} блоков Base (13-21 мин)")


def cmd_bridge(args):
    """Ждёт зачисления и сразу проводит перевод + минт (аттестация живёт ~10 мин)."""
    if not args.yes:
        die("bridge подпишет burn intent и отправит транзакцию mint. Добавьте --yes для подтверждения")
    a = account()
    recipient = args.recipient or a.address
    target = int(round(args.amount * 1e6)) if args.amount else None

    deadline = time.time() + args.wait * 60
    while True:
        avail, _ = gateway_balance(a.address)
        need = target or 1
        if avail >= need:
            log(f"✓ доступно {avail/1e6:,.6f} USDC")
            break
        if time.time() > deadline:
            die(f"не дождался зачисления: доступно {avail/1e6:,.6f}")
        log(f"  жду зачисления… доступно {avail/1e6:,.6f}")
        time.sleep(30)

    # Не угадываем fee. Сначала оцениваем запрошенную сумму, затем при
    # необходимости уменьшаем value ровно на возвращённую Circle комиссию.
    value = target or avail
    estimated = None
    for _ in range(3):
        if value <= 0:
            die("после резерва под комиссию переводить нечего")
        spec = make_spec(a, value, recipient)
        estimated = estimate_self_mint(spec)
        max_fee = estimated["maxFee"]
        adjusted = min(value, avail - max_fee)
        if adjusted <= 0:
            die(f"Gateway-баланса не хватает на сумму и fee {max_fee / 1e6:.6f} USDC")
        if adjusted == value:
            break
        value = adjusted
    else:
        die("не удалось стабилизировать сумму после fee estimate")

    if estimated is None:
        die("Circle estimate не получен")
    wire, sig = sign_burn_intent(a, estimated)
    max_fee = int(wire["maxFee"])
    max_block = int(wire["maxBlockHeight"])
    base_head = int(rpc(BASE_RPCS, "eth_blockNumber", []) or "0x0", 16)
    if max_block < base_head + MIN_BLOCK_WINDOW:
        die(f"Circle вернул слишком короткий maxBlockHeight: {max_block}; текущий Base: {base_head}")
    log(f"fee по estimate: {max_fee / 1e6:.6f} USDC | maxBlockHeight: {max_block}")

    # Форвардер опционален: на момент проверки он возвращал 503.
    if args.forwarder:
        log("пробую форвардер (Circle минтит сама)…")
        res = gw_api("/transfer?enableForwarder=true", [{"burnIntent": wire, "signature": sig}])
        if isinstance(res, dict) and res.get("transferId") and not res.get("attestation"):
            log(f"✓ форвардер принял, transferId {res['transferId']}")
            log("  опрашивайте GET /v1/transfer/<transferId> до статуса minted")
            return
        log(f"  форвардер недоступен: {str(res.get('message'))[:80]}")

    log(f"запрос аттестации на {value/1e6:,.6f} USDC → {recipient}")
    res = gw_api("/transfer", [{"burnIntent": wire, "signature": sig}])
    if not (isinstance(res, dict) and res.get("attestation")):
        die(f"аттестация не выдана: {json.dumps(res, ensure_ascii=False)[:300]}")
    att, asig = res["attestation"], res.get("signature")
    fee = (res.get("fees") or {}).get("total")
    log(f"✓ аттестация {len(att)//2} байт | transferId {res.get('transferId')}"
        + (f" | комиссия {fee}" if fee else ""))
    save_state(attestation=att, att_signature=asig, recipient=recipient,
               value=value, max_fee=max_fee, transfer_id=res.get("transferId"))

    cd = mint_calldata(att, asig)
    if args.calldata:
        log("\nОтдайте это любому, у кого есть газ на Arc — получатель зашит в аттестацию:")
        log(f"  сеть: Arc mainnet (chain id {CHAIN_ARC})")
        log(f"  to:   {GATEWAY_MINTER}")
        log(f"  data: {cd}")
        log("\n⚠ подать нужно в течение ~10 минут, иначе аттестация протухнет")
        return

    gas_bal = int(rpc(ARC_RPCS, "eth_getBalance", [a.address, "latest"]) or "0x0", 16)
    if gas_bal < 5 * 10**15:
        die("на Arc нет газа (~0.005 USDC на минт). Перезапустите с --calldata "
            "и отдайте вызов релееру")
    log("gatewayMint на Arc")
    build_and_send(ARC_RPCS, a, CHAIN_ARC, GATEWAY_MINTER, cd, "gatewayMint", 2_000_000_000)
    final = int(rpc(ARC_RPCS, "eth_getBalance", [recipient, "latest"]) or "0x0", 16)
    log(f"ИТОГО на Arc у {recipient}: {final/1e18:,.6f} USDC")


def main():
    p = argparse.ArgumentParser(description="Bridge USDC: Base -> Arc via Circle Gateway")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("balance", help="балансы на Base, в Gateway и на Arc")

    d = sub.add_parser("deposit", help="approve + deposit в GatewayWallet на Base")
    d.add_argument("--amount", type=float, required=True)
    d.add_argument("--yes", action="store_true", help="реально отправить транзакции")

    b = sub.add_parser("bridge", help="дождаться зачисления и провести перевод + минт")
    b.add_argument("--amount", type=float, help="сколько перевести (по умолчанию всё доступное)")
    b.add_argument("--recipient", help="получатель на Arc (по умолчанию свой адрес)")
    b.add_argument("--yes", action="store_true", help="подписать burn intent и отправить mint")
    b.add_argument("--wait", type=int, default=45, help="сколько минут ждать зачисления")
    b.add_argument("--calldata", action="store_true", help="не минтить самому, выдать calldata")
    b.add_argument("--forwarder", action="store_true", help="сначала попробовать Circle Forwarder")

    args = p.parse_args()
    {"balance": cmd_balance, "deposit": cmd_deposit, "bridge": cmd_bridge}[args.cmd](args)


if __name__ == "__main__":
    main()
