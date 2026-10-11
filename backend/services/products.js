const economy = require('./economy');

const KAVX_PACKAGES = economy.PACKAGES.map((p) => ({
  productId: p.productId,
  amount: p.amount,
  kavx: p.amount,
  label: p.label,
  aliases: p.aliases || []
}));

const DEVELOPER_MODE_COST = 0;

function getPackage(productId) {
  if (!productId) return null;
  const id = String(productId);
  return KAVX_PACKAGES.find((p) => p.productId === id || (p.aliases && p.aliases.includes(id))) || null;
}

module.exports = { KAVX_PACKAGES, DEVELOPER_MODE_COST, getPackage };
