#!/usr/bin/env node
/**
 * ===========================================================================
 * PRE-FLIGHT CHECK — run this BEFORE you show the client anything.
 * ===========================================================================
 *   node preflight.js
 *
 * Reads the same .env as server.js and verifies, against the live Meta Graph
 * API and your deployed Render URL, every single thing that has to be true
 * for the flow to work. Exits 1 if anything is broken.
 *
 * Extra env needed beyond server.js:
 *   PUBLIC_URL=https://your-service.onrender.com
 *   WABA_ID=...        (WhatsApp Manager > your WABA > ID)
 *   APP_ID=...         (Meta App dashboard > App ID)
 * ===========================================================================
 */
require('dotenv').config();

const G = process.env.GRAPH_VERSION || 'v21.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const WABA_ID = process.env.WABA_ID;
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENER_TEMPLATE = process.env.OPENER_TEMPLATE_NAME;
const NUDGE_TEMPLATE = process.env.NUDGE_TEMPLATE_NAME;
const API_KEY = process.env.API_KEY || '';

const results = [];
const pass = (n, d) => results.push({ s: 'PASS', n, d });
const warn = (n, d) => results.push({ s: 'WARN', n, d });
const fail = (n, d) => results.push({ s: 'FAIL', n, d });

const graph = async (path, params = {}) => {
  const u = new URL(`https://graph.facebook.com/${G}/${path}`);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  if (!u.searchParams.has('access_token')) u.searchParams.set('access_token', TOKEN);
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: j };
};

// ---------------------------------------------------------------------------
async function checkEnv() {
  const required = {
    META_ACCESS_TOKEN: TOKEN,
    PHONE_NUMBER_ID: PHONE_ID,
    VERIFY_TOKEN,
    OPENER_TEMPLATE_NAME: OPENER_TEMPLATE,
    PUBLIC_URL
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) fail('env', `missing: ${missing.join(', ')}`);
  else pass('env', 'all required vars present');

  if (!APP_SECRET) warn('env', 'APP_SECRET unset — webhook signatures unverified');
  if (!API_KEY) warn('env', 'API_KEY unset — your /api routes are open to the internet');
  if (!WABA_ID) warn('env', 'WABA_ID unset — cannot check templates or subscription');
  if (!APP_ID) warn('env', 'APP_ID unset — cannot check webhook field subscription');
}

async function checkServerUp() {
  if (!PUBLIC_URL) return;
  const t0 = Date.now();
  try {
    const r = await fetch(`${PUBLIC_URL}/health`, { signal: AbortSignal.timeout(60000) });
    const ms = Date.now() - t0;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return fail('server', `/health returned ${r.status}`);
    pass('server', `up in ${ms}ms — sessions:${j.sessions} agents:${j.agents} llm:${j.llm}`);
    if (ms > 3000) {
      fail('server:coldstart',
        `${ms}ms to respond. Meta times out webhooks in ~5s. You are on a sleeping ` +
        `free instance — upgrade the Render plan or inbound replies WILL be dropped.`);
    } else {
      pass('server:coldstart', `${ms}ms — instance is warm`);
    }
  } catch (e) {
    fail('server', `unreachable: ${e.message}`);
  }
}

async function checkWebhookVerify() {
  if (!PUBLIC_URL || !VERIFY_TOKEN) return;
  const nonce = String(Date.now());
  const u = `${PUBLIC_URL}/webhook?hub.mode=subscribe` +
            `&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=${nonce}`;
  try {
    const r = await fetch(u);
    const body = (await r.text()).trim();
    if (r.ok && body === nonce) pass('webhook:verify', 'challenge echoed correctly');
    else fail('webhook:verify', `got ${r.status} "${body}" — VERIFY_TOKEN on Render must match Meta exactly`);
  } catch (e) {
    fail('webhook:verify', e.message);
  }
}

async function checkPhoneNumber() {
  if (!TOKEN || !PHONE_ID) return;
  const r = await graph(PHONE_ID, {
    fields: 'verified_name,display_phone_number,quality_rating,code_verification_status,throughput'
  });
  if (!r.ok) {
    return fail('meta:phone',
      `${r.data.error?.message || r.status}. Token expired or wrong PHONE_NUMBER_ID. ` +
      `Temporary tokens die in 24h — you need a System User permanent token.`);
  }
  const d = r.data;
  pass('meta:phone', `${d.display_phone_number} "${d.verified_name}" quality:${d.quality_rating}`);
  if (d.quality_rating && d.quality_rating !== 'GREEN') {
    warn('meta:phone', `quality is ${d.quality_rating} — your sending limits are throttled`);
  }
}

async function checkTokenLongevity() {
  if (!TOKEN || !APP_ID || !APP_SECRET) return;
  const r = await graph('debug_token', {
    input_token: TOKEN,
    access_token: `${APP_ID}|${APP_SECRET}`
  });
  const d = r.data?.data;
  if (!d) return warn('meta:token', 'could not inspect token');
  if (d.expires_at === 0 || !d.expires_at) {
    pass('meta:token', 'permanent (never expires)');
  } else {
    const hrs = Math.round((d.expires_at * 1000 - Date.now()) / 3600000);
    if (hrs < 72) {
      fail('meta:token',
        `expires in ${hrs}h. This is a temporary token — it will die mid-demo. ` +
        `Create a System User in Business Settings and generate a permanent token.`);
    } else {
      pass('meta:token', `valid for ${hrs}h`);
    }
  }
}

async function checkWabaSubscription() {
  if (!WABA_ID) return;
  const r = await graph(`${WABA_ID}/subscribed_apps`);
  if (!r.ok) return fail('meta:waba', r.data.error?.message || `status ${r.status}`);
  const apps = r.data.data || [];
  if (!apps.length) {
    return fail('meta:waba',
      'NO APP SUBSCRIBED to this WABA. This is the #1 cause of "first message ' +
      'sent but no replies came". Fix: Meta App > WhatsApp > Configuration > ' +
      'Webhook > Subscribe.');
  }
  pass('meta:waba', `subscribed app: ${apps.map((a) => a.whatsapp_business_api_data?.name).join(', ')}`);
}

async function checkWebhookFields() {
  if (!APP_ID || !APP_SECRET) return;
  const r = await graph(`${APP_ID}/subscriptions`, { access_token: `${APP_ID}|${APP_SECRET}` });
  if (!r.ok) return warn('meta:fields', r.data.error?.message || `status ${r.status}`);
  const waba = (r.data.data || []).find((x) => x.object === 'whatsapp_business_account');
  if (!waba) {
    return fail('meta:fields',
      'App has no whatsapp_business_account webhook subscription at all.');
  }
  const fields = (waba.fields || []).map((f) => f.name);
  if (!fields.includes('messages')) {
    fail('meta:fields',
      `subscribed fields are [${fields.join(', ')}] but "messages" is MISSING. ` +
      `Verification passes and outbound works, but you never receive replies. ` +
      `This is almost certainly what broke your last demo.`);
  } else {
    pass('meta:fields', `messages subscribed (fields: ${fields.join(', ')})`);
  }
  if (PUBLIC_URL && waba.callback_url && !waba.callback_url.startsWith(PUBLIC_URL)) {
    fail('meta:fields',
      `callback_url is ${waba.callback_url} but your server is ${PUBLIC_URL}/webhook`);
  } else if (waba.callback_url) {
    pass('meta:fields', `callback_url ${waba.callback_url}`);
  }
}

async function checkTemplates() {
  if (!WABA_ID) return;
  const r = await graph(`${WABA_ID}/message_templates`, { limit: 200 });
  if (!r.ok) return fail('meta:templates', r.data.error?.message || `status ${r.status}`);
  const all = r.data.data || [];

  for (const [label, name] of [['opener', OPENER_TEMPLATE], ['nudge', NUDGE_TEMPLATE]]) {
    if (!name) { warn(`template:${label}`, 'not configured'); continue; }
    const t = all.find((x) => x.name === name);
    if (!t) {
      fail(`template:${label}`,
        `"${name}" does not exist on this WABA. Existing: ${all.map((x) => x.name).join(', ') || 'none'}`);
      continue;
    }
    if (t.status !== 'APPROVED') {
      fail(`template:${label}`,
        `"${name}" status is ${t.status}${t.rejected_reason ? ` (${t.rejected_reason})` : ''}. ` +
        `Cold opens will fail until this is APPROVED.`);
      continue;
    }
    const body = (t.components || []).find((c) => c.type === 'BODY');
    const vars = new Set((body?.text || '').match(/\{\{\d+\}\}/g) || []);
    if (label === 'opener' && vars.size !== 1) {
      fail(`template:${label}`,
        `"${name}" has ${vars.size} variables. server.js sends exactly 1 (the lead's name). ` +
        `Mismatched parameter counts are rejected with error 132000.`);
    } else {
      pass(`template:${label}`, `"${name}" APPROVED (${t.category}, ${t.language}, ${vars.size} var)`);
    }
  }
}

async function checkAssets() {
  const urls = {
    brochure: process.env.ASSET_BROCHURE_URL,
    floorplan: process.env.ASSET_FLOORPLAN_URL,
    walkthrough: process.env.ASSET_WALKTHROUGH_URL,
    paymentplan: process.env.ASSET_PAYMENTPLAN_URL
  };
  for (const [k, url] of Object.entries(urls)) {
    if (!url) { warn(`asset:${k}`, 'not set — bot cannot fulfil this request'); continue; }
    try {
      const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-64' },
        signal: AbortSignal.timeout(15000) });
      const type = r.headers.get('content-type') || '';
      const size = r.headers.get('content-range')?.split('/')[1];
      if (!r.ok) { fail(`asset:${k}`, `HTTP ${r.status} — Meta must be able to fetch this publicly`); continue; }
      if (!url.startsWith('https://')) { fail(`asset:${k}`, 'must be https'); continue; }
      // Meta limits: documents 100MB, video 16MB
      const mb = size ? Number(size) / 1048576 : null;
      if (k === 'walkthrough' && mb && mb > 16) {
        fail(`asset:${k}`, `${mb.toFixed(1)}MB — WhatsApp video limit is 16MB. Compress or send a link instead.`);
      } else {
        pass(`asset:${k}`, `${type}${mb ? ` ${mb.toFixed(1)}MB` : ''}`);
      }
    } catch (e) {
      fail(`asset:${k}`, `unreachable: ${e.message}`);
    }
  }
}

async function checkDashboard() {
  const url = process.env.DASHBOARD_WEBHOOK_URL;
  if (!url) return warn('dashboard', 'DASHBOARD_WEBHOOK_URL unset — leads only hit the console');
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.DASHBOARD_WEBHOOK_SECRET
          ? { 'X-Webhook-Secret': process.env.DASHBOARD_WEBHOOK_SECRET } : {})
      },
      body: JSON.stringify({
        event: 'preflight.test',
        sentAt: new Date().toISOString(),
        lead: { phone: '910000000000', name: 'PREFLIGHT TEST', project: 'test',
                facing: 'East facing', unitSize: '2284 sq.ft.', budget: '₹2.25 Cr – ₹2.5 Cr',
                siteVisit: { type: 'weekday', day: 'Wednesday' }, stage: 'COMPLETED' },
        agent: { id: 'a1', name: 'Preflight' }
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (r.ok) pass('dashboard', `accepted test lead (HTTP ${r.status}) — go check it appeared`);
    else fail('dashboard', `HTTP ${r.status} — dashboard rejected the payload`);
  } catch (e) {
    fail('dashboard', `unreachable: ${e.message}`);
  }
}

async function checkApiAuth() {
  if (!PUBLIC_URL) return;
  try {
    const r = await fetch(`${PUBLIC_URL}/api/leads`);
    if (API_KEY && r.status !== 401) {
      fail('security', '/api/leads answered without a key — API_KEY not applied on Render');
    } else if (!API_KEY && r.ok) {
      warn('security', '/api/leads is publicly readable — set API_KEY on Render');
    } else {
      pass('security', '/api routes require X-Api-Key');
    }
  } catch { /* covered by server check */ }
}

// ---------------------------------------------------------------------------
(async () => {
  console.log('\n  PRE-FLIGHT — Raghava Speed-to-Lead\n  ' + '─'.repeat(70));
  await checkEnv();
  await checkServerUp();
  await checkWebhookVerify();
  await checkPhoneNumber();
  await checkTokenLongevity();
  await checkWabaSubscription();
  await checkWebhookFields();
  await checkTemplates();
  await checkAssets();
  await checkDashboard();
  await checkApiAuth();

  const icon = { PASS: '✅', WARN: '⚠️ ', FAIL: '❌' };
  for (const r of results) {
    console.log(`  ${icon[r.s]} ${r.n.padEnd(20)} ${r.d}`);
  }
  const fails = results.filter((r) => r.s === 'FAIL').length;
  const warns = results.filter((r) => r.s === 'WARN').length;
  console.log('  ' + '─'.repeat(70));
  console.log(`  ${results.filter(r => r.s === 'PASS').length} passed · ${warns} warnings · ${fails} failures\n`);
  if (fails) {
    console.log('  ⛔ DO NOT DEMO. Fix every ❌ above, then run this again.\n');
    process.exit(1);
  }
  console.log('  ✅ Cleared for the live test. Now message the number from your own phone.\n');
})();
