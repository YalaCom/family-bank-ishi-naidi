# Интеграция «Ищи-найди» в Family Bank

Игра — автономный фронтенд-модуль. Она **не** начисляет деньги, **не** ходит в вашу базу и **не** знает аккаунт, пока вы сами не передадите `userId`. Награду выдаёт только backend Family Bank после проверки раунда.

## Что открывать

Точка входа:

```
game/index.html
```

Демо в обычном браузере: просто откройте этот файл через любой статический сервер (или как `file://`). В адрес можно добавить `?demo=1`.

В Telegram Mini App откройте тот же `index.html` внутри WebView. Игра сама вызовет `Telegram.WebApp.ready()` / `expand()`, если скрипт Telegram уже инжектирован хостом. **Не подключайте** `telegram-web-app.js` из CDN внутри игры — это сделает основной сайт.

## Обязательные файлы

```
game/
  index.html          ← вход
  game.css
  game.js
  js/config.js        ← настройки
  js/data.js          ← карты, предметы, точки спавна
  assets/maps/*.jpg
  assets/objects/*.png
  assets/ui/hero.jpg
  assets/fonts/Nunito-Variable.ttf
```

Внешних библиотек нет (ни React, ни Phaser, ни CDN). Шрифт локальный.

## Как хост запускает раунд

Подключите папку `game/` как статику (iframe на весь экран Mini App или прямой route).

После загрузки `index.html`:

```html
<script>
  window.FamilyBankHost = {
    win:  (data) => sendToBackend("/game/complete", data),
    lose: (data) => sendToBackend("/game/complete", data),
  };

  window.FamilyBankGame.init({
    userId: String(tg.initDataUnsafe.user.id),
    attemptsLeft: 2,          // уже посчитано на сервере
    attemptsMax: 2,
    dayKey: "2026-08-26",     // серверный календарный день
    displayReward: 15,        // только текст на экране победы
    displayCurrency: "₽",
    nextResetAt: "2026-08-27T00:00:00+03:00",
    demo: false,
    onRoundStart: (payload) => {
      // POST /game/start  → сохранить раунд
      // верните { ok:false, reason:"limit" }, чтобы запретить старт
      return fetch("/api/game/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then((r) => r.json());
    },
    onResult: (payload) => {
      fetch("/api/game/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
  });
</script>
```

`init` можно вызвать и после загрузки, и из родительского окна, если игра в iframe — тогда используйте `iframe.contentWindow.FamilyBankGame.init(...)`.

## Как узнать о победе и проигрыше

Три равносильных канала (можно слушать любой один):

1. `FamilyBankGame.init({ onResult })`
2. `window.FamilyBankHost.win(data)` / `.lose(data)`
3. Событие `window.addEventListener("familybank:game-result", e => e.detail)`

`window.FamilyBankGame.win()` из консоли **ничего не начисляет** и не шлёт хосту победу. Это намеренная заглушка.

## Данные при завершении

```json
{
  "game": "seek",
  "roundId": "uuid",
  "result": "win",
  "reason": "found",
  "mapId": "village",
  "targetId": "frog",
  "spawnId": "v-pond-1",
  "click": { "nx": 0.201, "ny": 0.583 },
  "durationMs": 27440,
  "mistakes": 1,
  "hintsUsed": 0,
  "seed": 384756123,
  "startedAt": 1730000000000,
  "endedAt": 1730000027440,
  "demo": false,
  "proof": { "alg": "djb2", "hex": "a1b2c3d4", "len": 180 }
}
```

`result`: `"win"` | `"lose"`.  
`reason` при проигрыше: `"mistakes"` | `"timeout"` | `"quit"`.

Координаты `nx/ny` — нормализованные 0…1 относительно карты.

**Размер награды клиент не передаёт и не считает.**

## Что backend должен сохранить на СТАРТЕ раунда

Из `onRoundStart` payload:

| Поле | Зачем |
|---|---|
| `userId` | лимит 2/сутки и анти-абуз |
| `roundId` | идемпотентность, запрет повторной награды |
| `mapId`, `targetId`, `spawnId`, `nx`, `ny` | проверка клика |
| `seed` | воспроизведение раунда при споре |
| `startedAt` | анти-автоклик (слишком быстро) и таймаут |
| `telegramInitData` | проверка подписи Telegram |
| `dayKey` | суточный лимит |

И отдельно, из своей БД:

- сколько раундов пользователь уже начал **сегодня**
- статус раунда: `started` → `win` / `lose` / `expired`
- флаг `rewarded` (награда уже выдана)

Правило: **попытка списывается в момент старта**, не в момент победы. Если игрок закрыл Mini App — раунд `lose`/`expired`, попытка сгорела.

## Что проверить на ЗАВЕРШЕНИИ

1. `roundId` существует, принадлежит этому `userId`, статус `started`.
2. `result` + `proof` совпадают с записанными `mapId/targetId/spawnId/seed`.
3. Клик `click.nx/ny` лежит в радиусе цели (рекомендуется ≤ 0.05 по нормализованной диагонали). Для `lose` клик может быть `{-1,-1}`.
4. `durationMs` не меньше ~1.5 с (защита от автоклика) и не сильно больше лимита раунда + 15 с.
5. Сегодняшних стартов ≤ 2.
6. Награда начисляется **один раз** (`rewarded=false` → true в одной транзакции).
7. Сумма награды берётся **только с сервера** (сейчас 15 ₽ — константа Family Bank, не из клиента).

`proof.hex` — контрольная сумма полей на клиенте (`djb2`). Это не криптография. Настоящая защита — ваши записи старта. Когда будете готовы, замените proof на HMAC от Worker: Worker выдаёт `roundToken` на старте, клиент возвращает его на complete.

## Глобальный API

```js
window.FamilyBankGame.GAME_ID          // "seek"
window.FamilyBankGame.init(options)
window.FamilyBankGame.getState()
window.FamilyBankGame.startRound()     // то же, что кнопка «Играть»
window.FamilyBankGame.win()            // заглушка, всегда { ok:false }
window.FamilyBankGame.lose()           // заглушка
window.FamilyBankGame.onResult = fn    // можно назначить и после init
```

`getState()`:

```js
{
  game, userId, demo,
  attemptsLeft, attemptsMax, totalWins,
  dayKey, roundActive, roundId
}
```

## Где менять сложность и карты

| Что | Файл | Поля |
|---|---|---|
| Попытки в сутки, таймер, ошибки, размер карты, число декораций | `js/config.js` | `ATTEMPTS_PER_DAY`, `ROUND_SECONDS`, `MISTAKES_MAX`, `DECOY_COUNT`, `OBJECT_BASE_SIZE` |
| Предметы, имена, зоны | `js/data.js` → `OBJECTS` | `zones`, `size`, `rare` |
| Карты | `js/data.js` → `MAPS` + файл в `assets/maps/` | |
| Логичные места | `js/data.js` → `SPAWNS` | `nx`, `ny`, `zones` |

Новая карта: jpg 16:9 в `assets/maps/`, запись в `MAPS`, массив точек в `SPAWNS`, id в `MAP_ORDER`.

Предмет появляется только в точке, чьи `zones` пересекаются с `zones` предмета (лягушка → вода, вилы → сено, и т.д.).

## Telegram

Игра читает `window.Telegram.WebApp`, если он есть:

- `user.id` → `userId` (если хост не передал свой)
- `initData` уходит в `onRoundStart` как `telegramInitData`
- визуально: `expand`, тёмный header, `disableVerticalSwipes`

Лимит 2/сутки на клиенте — только UX. Реальный лимит обязан считать Worker + D1 по `userId` и серверной дате.

## Чего игра специально не делает

- нет своего бота, логина, баланса, выплаты
- нет запросов на ваш API, пока вы не передадите колбэки
- localStorage (`familybank_seek_v1`) — демо-статистика и коллекция, не источник истины для денег
