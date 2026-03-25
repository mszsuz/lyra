// Billing — deducts balance after each model response, publishes balance_update

import { deductBalance, setExchangeRate } from './users.mjs';
import * as log from './log.mjs';

const TAG = 'billing';

let costMultiplier = 1;

/**
 * Initialize billing with config.
 * @param {object} config — router config (reads billingMultiplier)
 */
export function initBilling(config) {
  costMultiplier = config.billingMultiplier ?? 1;
  const exchangeRate = config.exchangeRate ?? 100;
  setExchangeRate(exchangeRate);
  log.info(TAG, `Exchange rate: ${exchangeRate} руб/$, multiplier: ${costMultiplier}x`);
}

/**
 * Process a model event for billing.
 * Deducts balance on assistant_end with cost_usd.
 * @param {object} session - Session with userId, sessionId, channel
 * @param {object} event - Model event (checked for type === 'assistant_end')
 * @param {object} centrifugo - Centrifugo client for publishing balance_update
 */
export function processEvent(session, event, centrifugo) {
  if (event.type !== 'assistant_end') return;
  if (!event.cost_usd) return;
  if (!session.userId) return;
  if (event._suppress || event._internal) return;

  const effectiveCost = event.cost_usd * costMultiplier;
  const newBalance = deductBalance(session.userId, effectiveCost, session.sessionId, event.cost_usd);
  centrifugo.apiPublish(session.channel, {
    type: 'balance_update',
    session_id: session.sessionId,
    balance: newBalance,
    currency: 'руб',
  });
  log.info(TAG, `Balance: -${event.cost_usd}$${costMultiplier !== 1 ? ` x${costMultiplier} = -${effectiveCost.toFixed(4)}$` : ''} → ${newBalance} руб (user=${session.userId})`);
}

/**
 * Deduct accumulated cost directly (without assistant_end event).
 * Used when tool-turn loop ends abnormally and there's no final assistant_end to carry the cost.
 */
export function billAccumulatedCost(session, costUsd, centrifugo) {
  if (!costUsd || !session.userId) return;

  const effectiveCost = costUsd * costMultiplier;
  const newBalance = deductBalance(session.userId, effectiveCost, session.sessionId, costUsd);
  centrifugo.apiPublish(session.channel, {
    type: 'balance_update',
    session_id: session.sessionId,
    balance: newBalance,
    currency: 'руб',
  });
  log.info(TAG, `Balance (accumulated): -${costUsd}$${costMultiplier !== 1 ? ` x${costMultiplier} = -${effectiveCost.toFixed(4)}$` : ''} → ${newBalance} руб (user=${session.userId})`);
}
