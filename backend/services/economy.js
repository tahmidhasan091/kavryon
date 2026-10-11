/**
 * Server-side Kavx economy configuration.
 * Clients never decide reward amounts or limits.
 */
module.exports = {
  CURRENCY: 'KAVX',
  CURRENCY_DISPLAY: 'Kavx',
  DEVELOPER_MODE_COST: 0, // free creator mode

  // Gifts
  GIFT_MIN: 1,
  GIFT_MAX: 5000,
  GIFT_DAILY_SEND_LIMIT: 10000,
  GIFT_DAILY_COUNT_LIMIT: 50,

  // Creator rewards (server-calculated)
  REWARD_PUBLISH: 50,
  REWARD_PLAY_MILESTONE: 10, // per unique player engagement batch
  REWARD_LIKE_MILESTONE: 5,
  CREATOR_DAILY_CAP: 500,
  CREATOR_PER_GAME_DAILY_CAP: 200,
  PLAY_REWARD_COOLDOWN_MS: 60_000, // min interval between play-engagement rewards per (game,player)
  MIN_PLAYERS_FOR_ENGAGEMENT: 1,

  // Packages (amounts are server-only; productId supports legacy aliases)
  PACKAGES: [
    { productId: 'kavx_100', amount: 100, label: '100 Kavx', aliases: ['vyn_100'] },
    { productId: 'kavx_500', amount: 500, label: '500 Kavx', aliases: ['vyn_500'] },
    { productId: 'kavx_1200', amount: 1200, label: '1,200 Kavx', aliases: ['vyn_1200'] },
    { productId: 'kavx_2500', amount: 2500, label: '2,500 Kavx', aliases: ['vyn_2500'] },
    { productId: 'kavx_5500', amount: 5500, label: '5,500 Kavx', aliases: ['vyn_5500'] }
  ]
};
