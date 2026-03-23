// Billing — deducts balance after each model response, publishes balance_update

import { deductBalance } from './users.mjs';
import * as log from './log.mjs';

const TAG = 'billing';

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

  const newBalance = deductBalance(session.userId, event.cost_usd, session.sessionId);
  centrifugo.apiPublish(session.channel, {
    type: 'balance_update',
    session_id: session.sessionId,
    balance: newBalance,
    currency: 'руб',
  });
  log.info(TAG, `Balance: -${event.cost_usd}$ → ${newBalance} руб (user=${session.userId})`);
}
