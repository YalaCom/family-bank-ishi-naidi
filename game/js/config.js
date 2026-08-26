/* Family Bank — Ищи-найди
 * Все игровые настройки. Подробности — в GAME_CONFIG.md.
 * Меняйте значения здесь, не размазывая магические числа по коду.
 */
(function (g) {
  "use strict";

  g.CONFIG = {
    GAME_ID: "seek",
    GAME_TITLE: "Ищи-найди",
    GAME_SUBTITLE: "Family Bank",

    /* Попытки */
    ATTEMPTS_PER_DAY: 2,
    STORAGE_KEY: "familybank_seek_v1",
    STORAGE_VERSION: 1,

    /* Раунд */
    ROUND_SECONDS: 90,
    MISTAKES_MAX: 3,
    HINTS_PER_ROUND: 1,
    EMPTY_TAP_PENALTY: false,
    CONSUME_ATTEMPT_ON_START: true,
    ABANDON_COUNTS_AS_LOSE: true,

    /* Награда (только отображение — сумму назначает backend) */
    DISPLAY_REWARD: 15,
    DISPLAY_CURRENCY: "₽",

    /* Карта */
    MAP_WIDTH: 2400,
    MAP_HEIGHT: 1350,
    MIN_ZOOM_COVER: true,
    MAX_ZOOM: 3.2,
    START_ZOOM_EXTRA: 1.08,
    OBJECT_BASE_SIZE: 82,
    HIT_PADDING: 12,
    DECOY_COUNT: 16,
    MIN_SPAWN_DISTANCE: 0.06,

    /* Камера / ввод */
    PAN_TAP_SLOP: 12,
    DOUBLE_TAP_MS: 280,
    WHEEL_ZOOM_STEP: 0.0014,
    CAMERA_EASE: 7.5,

    /* Защита / proof */
    CLIENT_SALT: "fb-seek-v1-not-a-secret",
    HIT_RADIUS_NORM: 0.045,

    /* Демо */
    DEMO_USER_ID: "demo",
  };

  g.DAY_MS = 24 * 60 * 60 * 1000;
})(window.FBG = window.FBG || {});
