import { readFile, writeFile } from 'node:fs/promises';

function once(text, from, to, label) {
  const i = text.indexOf(from);
  if (i < 0) throw new Error(`Runtime integration missing: ${label}`);
  if (text.indexOf(from, i + from.length) >= 0) throw new Error(`Runtime integration ambiguous: ${label}`);
  return text.slice(0, i) + to + text.slice(i + from.length);
}

let js = await readFile('game/game.js','utf8');
if (!js.includes('FAMILY_BANK_SAME_ORIGIN_V1')) {
  js = once(js,
`    if (C.CONSUME_ATTEMPT_ON_START) {
      save.attemptsUsed += 1;
      if (typeof host.attemptsLeft === "number") host.attemptsLeft = Math.max(0, host.attemptsLeft - 1);
    }`,
`    if (C.CONSUME_ATTEMPT_ON_START) {
      save.attemptsUsed += 1;
      // Backend Family Bank already consumes a real attempt when it issues a server round.
      if (host.demo && typeof host.attemptsLeft === "number") host.attemptsLeft = Math.max(0, host.attemptsLeft - 1);
    }`,
'authoritative attempt counter');

  js = once(js,
`  function boot() {`,
`  // FAMILY_BANK_SAME_ORIGIN_V1 — game is served by the Family Bank Worker at /game/.
  function bankInitData() {
    let value = "";
    try { if (host.telegram && host.telegram.initData) value = host.telegram.initData; } catch (_) {}
    if (!value) {
      try { value = sessionStorage.getItem("familybank_init_data") || ""; } catch (_) {}
    }
    return value;
  }

  function userIdFromInitData(initData) {
    try {
      const p = new URLSearchParams(initData || "");
      const u = JSON.parse(p.get("user") || "null");
      return u && u.id ? String(u.id) : null;
    } catch (_) { return null; }
  }

  async function bankApi(path, payload) {
    const initData = bankInitData();
    if (!initData) throw new Error("Открой игру из Family Bank");
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Init-Data": initData },
      body: JSON.stringify(payload || {}),
    });
    let data = {};
    try { data = await r.json(); } catch (_) {}
    if (!r.ok || data.ok === false) throw new Error(data.error || "Ошибка Family Bank");
    return data;
  }

  function installFamilyBankBackend() {
    const initData = bankInitData();
    if (!initData) return false;

    host.demo = false;
    const uid = userIdFromInitData(initData);
    if (uid) host.userId = uid;
    host.attemptsMax = 2;
    host.displayReward = 15;
    host.displayCurrency = "₽";

    host.onRoundStart = async function () {
      return bankApi("/api/game/start", { game: C.GAME_ID });
    };

    host.onResult = function (payload) {
      let tries = 0;
      const send = function () {
        tries += 1;
        bankApi("/api/game/complete", payload).then(function (res) {
          if (typeof res.attemptsLeft === "number") host.attemptsLeft = Math.max(0, res.attemptsLeft);
          if (res.dayKey) host.dayKey = res.dayKey;
          if (res.nextResetAt) host.nextResetAt = res.nextResetAt;
          if (payload.result === "win") toast(res.rewarded ? "+" + (res.reward || 15) + " ₽ начислено" : "Победа уже учтена");
          refreshHome();
        }).catch(function () {
          if (tries < 3) window.setTimeout(send, 800 * tries);
          else if (payload.result === "win") toast("Не удалось подтвердить награду");
        });
      };
      send();
    };

    bankApi("/api/game/state", { game: C.GAME_ID }).then(function (res) {
      if (typeof res.attemptsLeft === "number") host.attemptsLeft = Math.max(0, res.attemptsLeft);
      if (typeof res.attemptsMax === "number") host.attemptsMax = res.attemptsMax;
      if (res.dayKey) host.dayKey = res.dayKey;
      if (res.nextResetAt) host.nextResetAt = res.nextResetAt;
      if (res.reward != null) host.displayReward = res.reward;
      save = loadSave(host.userId || C.DEMO_USER_ID);
      save.userId = host.userId || C.DEMO_USER_ID;
      persist();
      refreshHome();
    }).catch(function () {
      host.attemptsLeft = 0;
      refreshHome();
      toast("Нет связи с Family Bank");
    });
    return true;
  }

  function boot() {`,
'Family Bank same-origin backend helpers');

  js = once(js,
`    if (q.get("demo") === "1") host.demo = true;
    if (q.get("user")) host.userId = q.get("user");

    save = loadSave(host.userId || C.DEMO_USER_ID);`,
`    if (q.get("demo") === "1") host.demo = true;
    if (q.get("user")) host.userId = q.get("user");
    if (q.get("demo") !== "1") installFamilyBankBackend();

    save = loadSave(host.userId || C.DEMO_USER_ID);`,
'boot backend install');

  js = once(js,
`  function bind() {
    $("btn-play").addEventListener("click", function () {`,
`  function bind() {
    $("btn-bank-back").addEventListener("click", function () {
      location.href = "/";
    });
    $("btn-play").addEventListener("click", function () {`,
'Family Bank back button binding');
}
await writeFile('game/game.js', js, 'utf8');

let html = await readFile('game/index.html','utf8');
if (!html.includes('id="btn-bank-back"')) {
  html = once(html,
`    <section id="screen-home" class="screen active" data-screen="home">
      <div class="home-hero">`,
`    <section id="screen-home" class="screen active" data-screen="home">
      <button class="bank-back" id="btn-bank-back" type="button" aria-label="Вернуться в Family Bank">Family Bank</button>
      <div class="home-hero">`,
'back button markup');
}
await writeFile('game/index.html', html, 'utf8');

let css = await readFile('game/game.css','utf8');
if (!css.includes('.bank-back{')) {
  css += `\n\n.bank-back{position:absolute;z-index:20;top:calc(12px + env(safe-area-inset-top));left:14px;border:1px solid rgba(255,255,255,.16);background:rgba(20,28,22,.78);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);color:#fff;padding:9px 13px;border-radius:14px;font:700 13px/1.1 inherit;letter-spacing:.1px}\n.bank-back:active{transform:scale(.97)}\n`;
}
await writeFile('game/game.css', css, 'utf8');

for (const marker of ['FAMILY_BANK_SAME_ORIGIN_V1','/api/game/start','/api/game/complete','btn-bank-back']) {
  const all = js + html;
  if (!all.includes(marker)) throw new Error(`Expected marker missing: ${marker}`);
}
console.log('Family Bank same-origin runtime integration applied');
