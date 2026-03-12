// JWT generation — HMAC SHA-256, zero dependencies

import { createHmac } from 'node:crypto';

export function generateJWT(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function makeSessionJWTs(sessionId, secret) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 365 * 24 * 3600; // 1 year
  const channel = `session:${sessionId}`;

  const chatJwt = generateJWT({
    sub: `chat-${sessionId}`,
    channels: [channel],
    exp,
  }, secret);

  const mobileJwt = generateJWT({
    sub: `mobile-${sessionId}`,
    channels: [channel],
    exp,
  }, secret);

  return { chatJwt, mobileJwt, channel };
}

export function makeRouterJWT(secret, channels = []) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 'router-1',
    exp: now + 365 * 24 * 3600,
  };
  if (channels.length > 0) {
    payload.channels = channels;
  }
  return generateJWT(payload, secret);
}
