'use strict';
// The fifteen simulated tickers and their starting prices (the list is fixed by CLAUDE.md; do not add others).
const START_PRICES = {
  AMZN: 225.40,
  NVDA: 184.22,
  ANTH: 312.00, // Anthropic, simulated private-company listing
  IBM: 268.10,
  AMD: 158.30,
  INTC: 38.20,
  META: 712.40,
  CRM: 312.55,
  SNOW: 214.80,
  CRWD: 476.20,
  PANW: 201.30,
  ANET: 142.70,
  NBIS: 98.40,
  CRWV: 124.60,
  NFLX: 1102.50,
};

module.exports = { START_PRICES, SYMBOLS: Object.keys(START_PRICES) };
