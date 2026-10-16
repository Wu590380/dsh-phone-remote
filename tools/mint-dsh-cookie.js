/*
 * 给 dsh web（0.2.x 的 BrowserAuth）签发一个浏览器会话 cookie。
 *
 * 原理（读 dsh-client-connection 实现得来）：
 *   cookie 名 = 'dsh-auth-' + base64url(sha256(authority))
 *   cookie 值 = 'v1.' + base64url(JSON{version,authority,issuedAt,expiresAt}) + '.' + base64url(HMAC-SHA256(secret, body))
 *   secret 存在 <DSH_HOME>/.credentials.yaml 的 records['client-connection/browser-session'].payload.secret（base64url, 32 字节）
 *   服务端校验：名字对应 authority、签名对、authority 一致、时间窗内。
 *
 * 用法：
 *   node mint-dsh-cookie.js --home <DSH_HOME> --authority 127.0.0.1:19387 [--days 30]
 * 输出：
 *   cookie 名=值   （默认一行，便于直接塞进 curl 的 -H Cookie: 或代码里）
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const COOKIE_PREFIX = 'dsh-auth-';
const COOKIE_PAYLOAD_VERSION = 1;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
function cookieName(authority) {
  return COOKIE_PREFIX + b64url(crypto.createHash('sha256').update(authority).digest());
}
function encodeCookie(payload, secret) {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `v1.${body}.${b64url(crypto.createHmac('sha256', secret).update(body).digest())}`;
}

/** 从 .credentials.yaml 里抠出 browser-session secret（不依赖 yaml 库，按缩进解析） */
function readSecret(home) {
  const file = path.join(home, '.credentials.yaml');
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  let inRecord = false, inPayload = false, secret = '';
  for (const line of lines) {
    if (/^\S/.test(line)) { inRecord = false; inPayload = false; }
    if (/^\s{2}client-connection\/browser-session:\s*$/.test(line)) { inRecord = true; continue; }
    if (inRecord && /^\s{4}payload:\s*$/.test(line)) { inPayload = true; continue; }
    if (inPayload) {
      const m = /^\s{6}secret:\s*(\S+)\s*$/.exec(line);
      if (m) { secret = m[1]; break; }
    }
  }
  if (!secret) throw new Error('没在 ' + file + ' 里找到 client-connection/browser-session 的 secret');
  return secret;
}

function mint(home, authority, days) {
  const secret = fromB64url(readSecret(home));
  if (secret.byteLength !== 32) throw new Error('secret 长度不是 32 字节：' + secret.byteLength);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + (days || 30) * 24 * 3600 * 1000;
  const value = encodeCookie({ version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt }, secret);
  return { name: cookieName(authority), value, authority, issuedAt, expiresAt };
}

if (require.main === module) {
  try {
    const home = arg('home', path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'));
    const authority = arg('authority', '127.0.0.1:19387');
    const days = parseInt(arg('days', '30'), 10);
    const c = mint(home, authority, days);
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(c));
    } else {
      console.log(`${c.name}=${c.value}`);
    }
  } catch (e) {
    console.error('签发失败: ' + e.message);
    process.exit(1);
  }
}

module.exports = { mint, cookieName, encodeCookie };
