#!/usr/bin/env node
'use strict';

/**
 * JWT Token Generator for Lyra Bridge
 *
 * Generates HS256 JWT tokens for WebSocket authentication.
 *
 * Usage:
 *   node generate-token.js --secret SECRET --user USERNAME [--role ROLE] [--expires HOURS]
 *
 * Example:
 *   node generate-token.js --secret mysecret --user "Иванов И.И." --role admin --expires 24
 */

const crypto = require('crypto');

const args = process.argv.slice(2);

function argVal(name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

function usage() {
  console.error('Usage: node generate-token.js --secret SECRET --user USERNAME [--role ROLE] [--expires HOURS]');
  console.error('');
  console.error('Options:');
  console.error('  --secret   JWT secret key (required)');
  console.error('  --user     Username (required)');
  console.error('  --role     User role (default: "user")');
  console.error('  --expires  Token lifetime in hours (default: 24)');
  console.error('');
  console.error('Example:');
  console.error('  node generate-token.js --secret mysecret --user "Иванов" --role admin --expires 24');
  process.exit(1);
}

const secret = argVal('--secret');
const user = argVal('--user');
const role = argVal('--role') || 'user';
const expiresHours = Number(argVal('--expires')) || 24;

if (!secret || !user) {
  usage();
}

// Generate JWT token
const header = {
  alg: 'HS256',
  typ: 'JWT'
};

const now = Math.floor(Date.now() / 1000);
const payload = {
  sub: user,
  role: role,
  iat: now,
  exp: now + (expiresHours * 3600)
};

const base64url = (str) => {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
};

const headerB64 = base64url(JSON.stringify(header));
const payloadB64 = base64url(JSON.stringify(payload));

const signatureInput = `${headerB64}.${payloadB64}`;
const signature = crypto
  .createHmac('sha256', secret)
  .update(signatureInput)
  .digest('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=/g, '');

const token = `${headerB64}.${payloadB64}.${signature}`;

console.log(token);
