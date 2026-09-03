/**
 * ===========================================================================
 * RAGHAVA PROJECTS — SPEED-TO-LEAD WHATSAPP ASSISTANT
 * ===========================================================================
 * Node 18+ required (uses global fetch).
 *
 * Flow:
 *   trigger -> "Hi {name}, how are you?"  (template, cold contact)
 *     -> "who is this?"  -> persona intro -> Q1
 *     -> any reply       -> Q1
 *     -> no reply (90s)  -> Q1 (auto nudge)
 *   Q1 Facing  -> East / West / North
 *   Q2 Size    -> depends on facing (West = single inventory statement, skips ahead)
 *   Q3 Budget  -> 4 brackets
 *   Q4 Site visit pitch -> Weekdays / Weekends
 *   Q5 Day     -> Mon-Fri  or  Sat/Sun
 *   -> "Done" + "Let's connect back in some time."
 *   -> lead pushed to assigned agent's dashboard (round robin)
 *
 * Out-of-flow messages are answered (asset intents first, then LLM),
 * then the current question is re-asked.
 * ===========================================================================
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
require('dotenv').config();

// ===========================================================================
// ENV
// ===========================================================================
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'raghava_secret_token_2026';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const APP_SECRET = process.env.APP_SECRET || '';           // for X-Hub-Signature-256
const API_KEY = process.env.API_KEY || '';                 // protects /api/*
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v21.0';

// Persona the bot speaks as
const AGENT_PERSONA_NAME = process.env.AGENT_PERSONA_NAME || 'Rahul';
const COMPANY_NAME = process.env.COMPANY_NAME || 'Raghava Projects';
const DEFAULT_PROJECT = process.env.DEFAULT_PROJECT || 'Linq';

// Cold-open template (REQUIRED for contacts outside the 24h service window)
const OPENER_TEMPLATE_NAME = process.env.OPENER_TEMPLATE_NAME || '';
const OPENER_TEMPLATE_LANG = process.env.OPENER_TEMPLATE_LANG || 'en';
const NUDGE_TEMPLATE_NAME = process.env.NUDGE_TEMPLATE_NAME || '';
const NUDGE_TEMPLATE_LANG = process.env.NUDGE_TEMPLATE_LANG || 'en';

// Timing
const NUDGE_OPENER_MS = int(process.env.NUDGE_OPENER_MS, 90 * 1000);   // "after a minute or two"
const NUDGE_INTRO_MS = int(process.env.NUDGE_INTRO_MS, 60 * 1000);
const NUDGE_STEP_MS = int(process.env.NUDGE_STEP_MS, 4 * 60 * 1000);  // silence mid-flow
const MAX_STEP_NUDGES = int(process.env.MAX_STEP_NUDGES, 2);
const TYPING_DELAY_MS = int(process.env.TYPING_DELAY_MS, 1400);       // gap between chained msgs
const SESSION_TTL_MS = int(process.env.SESSION_TTL_MS, 72 * 60 * 60 * 1000);

// LLM fallback
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'claude-haiku-4-5-20251001';

// Dashboard / CRM
const DASHBOARD_WEBHOOK_URL = process.env.DASHBOARD_WEBHOOK_URL || '';
const DASHBOARD_WEBHOOK_SECRET = process.env.DASHBOARD_WEBHOOK_SECRET || '';

// Local persistence (single instance only — use Redis/Postgres in production)
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '.state.json');

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

// ===========================================================================
// 📝 EDIT EVERYTHING THE BOT SAYS HERE
// ===========================================================================
const SCRIPT = {

  // --- Step 0: cold opener -------------------------------------------------
  opener: (name) => `Hi ${name ? name : 'there'}, how are you?`,

  // --- Step 0b: "who is this?" ---------------------------------------------
  intro: (project) =>
    `I'm ${AGENT_PERSONA_NAME} from ${COMPANY_NAME}. I think you enquired about ` +
    `*${project}* — just reaching out to share a few more details with you.`,

  // --- Q1: Facing ----------------------------------------------------------
  q1_facing: {
    body: 'Do you have any facing preference for the flat?',
    options: [
      { id: 'east',  title: 'East facing',  keywords: ['east', 'east facing', 'purva'] },
      { id: 'west',  title: 'West facing',  keywords: ['west', 'west facing', 'paschim'] },
      { id: 'north', title: 'North facing', keywords: ['north', 'north facing', 'north east', 'ne'] }
    ]
  },

  // --- Q2: Unit size (branches on facing) ----------------------------------
  q2_size: {
    body: 'What unit size would you prefer?',
    byFacing: {
      east: [
        { id: 'e1855', title: '1855 sq.ft.', keywords: ['1855'] },
        { id: 'e1952', title: '1952 sq.ft.', keywords: ['1952'] },
        { id: 'e2284', title: '2284 sq.ft.', keywords: ['2284'] },
        { id: 'e2388', title: '2388 sq.ft.', keywords: ['2388'] }
      ],
      north: [
        { id: 'n1798', title: '1798 sq.ft.', keywords: ['1798'] },
        { id: 'n1952', title: '1952 sq.ft.', keywords: ['1952'] }
      ]
      // west has no choice — single inventory, handled below
    },
    // West: state the inventory and move straight to budget
    westStatement: 'In west facing we have 2044 sq.ft. flats.',
    westSizeLabel: '2044 sq.ft.'
  },

  // --- Q3: Budget ----------------------------------------------------------
  q3_budget: {
    body: 'What is the budget you are comfortable with?',
    options: [
      { id: 'b1', title: '₹1.75 Cr – ₹2 Cr',    keywords: ['1.75', '1.75 cr', '175'] },
      { id: 'b2', title: '₹2 Cr – ₹2.25 Cr',    keywords: ['2 cr', '2cr', '2 to 2.25'] },
      { id: 'b3', title: '₹2.25 Cr – ₹2.5 Cr',  keywords: ['2.25', '2.25 cr', '225'] },
      { id: 'b4', title: '₹2.5 Cr and above',   keywords: ['2.5+', '2.5 cr+', 'above 2.5', '2.75', '3 cr', '3cr'] }
    ]
  },

  // --- Q4: Site visit pitch ------------------------------------------------
  // Client's original line is kept below as `visitPitchOriginal` — flip
  // USE_ORIGINAL_PITCH to true in the config object if they prefer it verbatim.
  visitPitch:
    'Sir, right now our conversation is only end to end — what the sizes are, ' +
    'what the prices are.\n\n' +
    'The things that actually decide your purchase — the amenities, the view from ' +
    'your floor, the quality of finishing, how the location feels — you\'ll only ' +
    'get a complete idea of that on a site visit.\n\n' +
    'It takes about 30–40 minutes. Let me block a slot for you.',

  visitPitchOriginal:
    'See sir, our conversation is very end to end right now — like what are the ' +
    'sizes and what are the prices.\n\n' +
    'You will get a complete idea about the project, like the amenities that ' +
    'you\'re getting, once you do a site visit.',

  q4_visit_type: {
    body: 'What works better for you?',
    options: [
      { id: 'weekday', title: 'Weekdays', keywords: ['weekday', 'week day', 'weekdays', 'working day'] },
      { id: 'weekend', title: 'Weekends', keywords: ['weekend', 'week end', 'weekends'] }
    ]
  },

  q5_day: {
    body: 'Which day suits you?',
    weekday: [
      { id: 'mon', title: 'Monday',    keywords: ['monday', 'mon'] },
      { id: 'tue', title: 'Tuesday',   keywords: ['tuesday', 'tue', 'tues'] },
      { id: 'wed', title: 'Wednesday', keywords: ['wednesday', 'wed'] },
      { id: 'thu', title: 'Thursday',  keywords: ['thursday', 'thu', 'thur', 'thurs'] },
      { id: 'fri', title: 'Friday',    keywords: ['friday', 'fri'] }
    ],
    weekend: [
      { id: 'sat', title: 'Saturday', keywords: ['saturday', 'sat'] },
      { id: 'sun', title: 'Sunday',   keywords: ['sunday', 'sun'] }
    ]
  },

  // --- Overseas (non-Indian number) — no site visit, send the walkthrough ---
  nri: {
    pitch:
      'Sir, since you\'re currently overseas, a site visit isn\'t practical — so ' +
      'let me send you the full project walkthrough instead.\n\n' +
      'It covers the apartment layouts, the amenities and the surroundings, so ' +
      'you get the same picture you would get standing on site.',
    afterVideo:
      'Do have a look when you get a moment. If you\'d like the floor plans or ' +
      'the payment schedule as well, just ask me here.',
    // Only used when NRI_ASK_VIDEO_CALL=true
    videoCallAsk: {
      body: 'Would you like a live video call with our relationship manager, ' +
            'walking you through the actual floor?',
      options: [
        { id: 'vc_yes', title: 'Yes, arrange it', keywords: ['yes', 'ok', 'sure', 'please', 'arrange'] },
        { id: 'vc_no',  title: 'Not right now',  keywords: ['no', 'later', 'not now'] }
      ]
    },
    videoCallYes:
      'Our relationship manager will message you here to fix a time that suits ' +
      'your timezone.',
    videoCallNo: 'No problem at all.'
  },

  // --- Closing -------------------------------------------------------------
  done1: 'Done ✅',
  done2: 'Let\'s connect back in some time.',

  // --- Reprompts -----------------------------------------------------------
  reprompt: 'Just pick one of the options below and we\'ll move ahead.',
  fallbackGeneric:
    `Thanks for messaging ${COMPANY_NAME}. Let me get you the details — ` +
    'one moment.',
  stalled:
    'No problem, I\'ll leave it here for now. Whenever you\'re free, just reply ' +
    'and we\'ll continue.'
};

const USE_ORIGINAL_PITCH = String(process.env.USE_ORIGINAL_PITCH || 'false') === 'true';

// Leads on a non-Indian number never get offered a site visit — they get the
// walkthrough video instead. Change DOMESTIC_COUNTRY_CODE if the rule moves.
const DOMESTIC_COUNTRY_CODE = process.env.DOMESTIC_COUNTRY_CODE || '91';
const DOMESTIC_LOCAL_DIGITS = int(process.env.DOMESTIC_LOCAL_DIGITS, 10);
// Off by default (client asked for video only). Set true to also ask an
// overseas lead whether they want a video call with the relationship manager.
const NRI_ASK_VIDEO_CALL = String(process.env.NRI_ASK_VIDEO_CALL || 'false') === 'true';

/** 919876543210 or 9876543210 -> domestic. Anything else -> overseas. */
function isDomesticNumber(phone) {
  const p = cleanPhone(phone);
  if (p.length === DOMESTIC_LOCAL_DIGITS) return true;                 // no country code
  return p.startsWith(DOMESTIC_COUNTRY_CODE) &&
         p.length === DOMESTIC_COUNTRY_CODE.length + DOMESTIC_LOCAL_DIGITS;
}

// ===========================================================================
// 📎 ASSETS — brochure / floor plan / walkthrough / payment plan
// Replace the URLs. Files must be publicly reachable over HTTPS.
// ===========================================================================
const ASSETS = {
  brochure: {
    keywords: ['brochure', 'broucher', 'pdf', 'details pdf', 'project details', 'send details'],
    type: 'document',
    url: process.env.ASSET_BROCHURE_URL || '',
    filename: 'Linq_Brochure.pdf',
    caption: 'Here is the complete Linq brochure.'
  },
  floorPlan: {
    keywords: ['floor plan', 'floorplan', 'layout', 'master plan', 'plan', 'unit plan'],
    type: 'document',
    url: process.env.ASSET_FLOORPLAN_URL || '',
    filename: 'Linq_Floor_Plans.pdf',
    caption: 'Floor plans for all unit sizes.'
  },
  walkthrough: {
    keywords: ['walkthrough', 'walk through', 'video', 'virtual tour', '3d', 'sample flat video'],
    type: 'video',
    url: process.env.ASSET_WALKTHROUGH_URL || '',
    caption: 'Linq walkthrough video.'
  },
  paymentPlan: {
    keywords: ['payment plan', 'payment schedule', 'emi', 'instalment', 'installment', 'loan', 'booking amount'],
    type: 'document',
    url: process.env.ASSET_PAYMENTPLAN_URL || '',
    filename: 'Linq_Payment_Plan.pdf',
    caption: 'Payment plan and schedule.'
  },
  location: {
    keywords: ['location', 'address', 'where is', 'google map', 'maps', 'site address'],
    type: 'text',
    text: process.env.ASSET_LOCATION_TEXT ||
      'Site address: ' + (process.env.SITE_ADDRESS || 'shared on request') +
      (process.env.SITE_MAP_URL ? `\n${process.env.SITE_MAP_URL}` : '')
  }
};

// Recognised as "who are you?"
const WHO_IS_THIS = [
  'who is this', 'who r u', 'who are you', 'who this', 'whos this', "who's this",
  'kaun', 'evaru', ' evaru', 'which company', 'from where', 'do i know you',
  'wrong number', 'who?', 'sorry who'
];

// Facts the LLM is allowed to use. Add real numbers here — it must not invent any.
const PROJECT_FACTS = process.env.PROJECT_FACTS || `
Builder: ${COMPANY_NAME}
Project name: ${DEFAULT_PROJECT}
Available facings: East, West, North.
East facing unit sizes: 1855, 1952, 2284, 2388 sq.ft.
West facing unit size: 2044 sq.ft.
North facing unit sizes: 1798, 1952 sq.ft.
Budget brackets discussed: 1.75-2 Cr, 2-2.25 Cr, 2.25-2.5 Cr, 2.5 Cr+.
Brochure, floor plans, walkthrough video and payment plan can be shared on WhatsApp.
Site visits are arranged on weekdays and weekends.
`.trim();

// ===========================================================================
// AGENTS — round robin
// AGENTS env: JSON array e.g.
//   [{"id":"a1","name":"Rahul","phone":"919000000001","email":"rahul@x.com"}]
// ===========================================================================
let AGENTS = [];
try {
  AGENTS = JSON.parse(process.env.AGENTS || '[]');
} catch (e) {
  console.error('AGENTS env is not valid JSON — falling back to empty list.');
}

// ===========================================================================
// STATE
// ===========================================================================
const STAGES = {
  OPENER_SENT: 'OPENER_SENT',
  INTRO_SENT: 'INTRO_SENT',
  Q1_FACING: 'Q1_FACING',
  Q2_SIZE: 'Q2_SIZE',
  Q3_BUDGET: 'Q3_BUDGET',
  Q4_VISIT_TYPE: 'Q4_VISIT_TYPE',
  Q5_DAY: 'Q5_DAY',
  NRI_VIDEO_CALL: 'NRI_VIDEO_CALL',
  COMPLETED: 'COMPLETED',
  STALLED: 'STALLED'
};

const store = {
  sessions: {},        // phone -> session
  rrIndex: 0,          // round robin pointer
  seenMessages: {},    // messageId -> ts (dedupe Meta retries)
  webhookLog: [],      // last 50 inbound hits — proves Meta is actually calling you
  sendLog: []          // last 50 outbound attempts + Meta's response
};

function trace(bucket, entry) {
  store[bucket].unshift({ at: new Date().toISOString(), ...entry });
  if (store[bucket].length > 50) store[bucket].length = 50;
}

const timers = new Map();   // phone -> Timeout
const locks = new Map();    // phone -> Promise chain

loadState();

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      store.sessions = raw.sessions || {};
      store.rrIndex = raw.rrIndex || 0;
      console.log(`[state] restored ${Object.keys(store.sessions).length} sessions`);
    }
  } catch (e) {
    console.error('[state] load failed:', e.message);
  }
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(
        DATA_FILE,
        JSON.stringify({ sessions: store.sessions, rrIndex: store.rrIndex })
      );
    } catch (e) {
      console.error('[state] save failed:', e.message);
    }
  }, 1000);
}

// ===========================================================================
// UTIL
// ===========================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanPhone = (p) => String(p || '').replace(/\D/g, '');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const now = () => Date.now();

function withinServiceWindow(session) {
  return session.lastInboundAt && (now() - session.lastInboundAt) < 24 * 60 * 60 * 1000;
}

/** Serialise handling per phone number so two fast replies can't race. */
function withLock(phone, fn) {
  const prev = locks.get(phone) || Promise.resolve();
  const next = prev.then(fn).catch((e) => console.error('[lock]', e));
  locks.set(phone, next.finally(() => {
    if (locks.get(phone) === next) locks.delete(phone);
  }));
  return next;
}

/**
 * Option matcher.
 *  1) exact option id (interactive reply)
 *  2) exact "1".."n" index
 *  3) whole-word keyword / title match
 */
function matchOption(input, options) {
  const norm = String(input || '').trim().toLowerCase();
  if (!norm) return null;

  const byId = options.find((o) => o.id.toLowerCase() === norm);
  if (byId) return byId;

  if (/^[0-9]{1,2}$/.test(norm)) {
    const idx = parseInt(norm, 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
  }

  for (const o of options) {
    const terms = [o.title.toLowerCase(), ...(o.keywords || [])];
    for (const t of terms) {
      const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(t.toLowerCase())}([^a-z0-9]|$)`, 'i');
      if (re.test(norm)) return o;
    }
  }
  return null;
}

function matchesAny(input, list) {
  const norm = String(input || '').toLowerCase();
  return list.some((k) => norm.includes(k));
}

function detectAsset(input) {
  const norm = String(input || '').toLowerCase();
  for (const [key, asset] of Object.entries(ASSETS)) {
    if (asset.keywords.some((k) => norm.includes(k))) return { key, asset };
  }
  return null;
}

// ===========================================================================
// WHATSAPP API
// ===========================================================================
async function callWhatsAppAPI(payload, attempt = 1) {
  if (!META_ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error('[wa] missing META_ACCESS_TOKEN / PHONE_NUMBER_ID');
    return { error: 'not_configured' };
  }
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );
    const data = await res.json().catch(() => ({}));
    trace('sendLog', {
      to: payload.to,
      type: payload.type || payload.status,
      httpStatus: res.status,
      ok: res.ok,
      error: res.ok ? null : (data.error?.message || JSON.stringify(data)),
      errorCode: res.ok ? null : (data.error?.code ?? null)
    });
    if (!res.ok) {
      console.error(`[wa] ${res.status}`, JSON.stringify(data));
      // one retry on 5xx / rate limit
      if (attempt === 1 && (res.status >= 500 || res.status === 429)) {
        await sleep(1200);
        return callWhatsAppAPI(payload, 2);
      }
    }
    return data;
  } catch (err) {
    console.error('[wa] fetch failed:', err.message);
    if (attempt === 1) { await sleep(1200); return callWhatsAppAPI(payload, 2); }
    return { error: err.message };
  }
}

const markAsRead = (messageId) =>
  messageId
    ? callWhatsAppAPI({ messaging_product: 'whatsapp', status: 'read', message_id: messageId })
    : null;

const sendText = (to, body) =>
  callWhatsAppAPI({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone(to),
    type: 'text',
    text: { body, preview_url: false }
  });

const sendTemplate = (to, name, lang, params = []) =>
  callWhatsAppAPI({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone(to),
    type: 'template',
    template: {
      name,
      language: { code: lang },
      components: params.length
        ? [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t) })) }]
        : []
    }
  });

/** ≤3 options -> reply buttons. >3 -> list message. */
function sendOptions(to, body, options, listButtonLabel = 'Choose') {
  const phone = cleanPhone(to);

  if (options.length <= 3) {
    return callWhatsAppAPI({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body.slice(0, 1024) },
        action: {
          buttons: options.slice(0, 3).map((o) => ({
            type: 'reply',
            reply: { id: o.id, title: o.title.slice(0, 20) }
          }))
        }
      }
    });
  }

  return callWhatsAppAPI({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: body.slice(0, 1024) },
      action: {
        button: listButtonLabel.slice(0, 20),
        sections: [
          {
            title: 'Options',
            rows: options.slice(0, 10).map((o) => ({
              id: o.id,
              title: o.title.slice(0, 24)
            }))
          }
        ]
      }
    }
  });
}

function sendAsset(to, asset) {
  const phone = cleanPhone(to);
  if (asset.type === 'text') return sendText(phone, asset.text);
  if (!asset.url) {
    return sendText(phone, 'Let me send that across shortly — my colleague will share it with you.');
  }
  if (asset.type === 'video') {
    return callWhatsAppAPI({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'video',
      video: { link: asset.url, caption: asset.caption }
    });
  }
  return callWhatsAppAPI({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'document',
    document: { link: asset.url, filename: asset.filename, caption: asset.caption }
  });
}

// ===========================================================================
// LLM FALLBACK (out-of-flow questions)
// ===========================================================================
async function llmAnswer(session, userMessage) {
  if (!ANTHROPIC_API_KEY) return null;

  const system =
    `You are ${AGENT_PERSONA_NAME}, a sales executive at ${COMPANY_NAME}, replying on WhatsApp ` +
    `to a property enquiry.\n\n` +
    `PROJECT FACTS (the only facts you may state):\n${PROJECT_FACTS}\n\n` +
    `RULES:\n` +
    `- Reply in 1-2 short sentences. WhatsApp tone, no bullet points, no markdown headings.\n` +
    `- Never invent prices, dates, approvals, RERA numbers, possession dates or any fact ` +
    `not listed above. If you don't know, say a colleague will confirm it.\n` +
    `- Do NOT ask the qualification question yourself — the system asks it right after you.\n` +
    `- Match the language the customer writes in (English / Hinglish / Telugu-English).\n` +
    `- Never mention that you are an AI or a bot.\n\n` +
    `Lead so far: facing=${session.facing || '-'}, size=${session.unitSize || '-'}, ` +
    `budget=${session.budget || '-'}, project=${session.project || DEFAULT_PROJECT}.`;

  const history = (session.transcript || []).slice(-8).map((t) => ({
    role: t.role,
    content: t.text
  }));

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 300,
        system,
        messages: [...history, { role: 'user', content: userMessage }]
      })
    });
    const data = await res.json();
    if (!res.ok) { console.error('[llm]', JSON.stringify(data)); return null; }
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    return text || null;
  } catch (e) {
    console.error('[llm] failed:', e.message);
    return null;
  }
}

// ===========================================================================
// AGENTS / DASHBOARD
// ===========================================================================
function assignAgentRoundRobin() {
  if (!AGENTS.length) return null;
  const agent = AGENTS[store.rrIndex % AGENTS.length];
  store.rrIndex = (store.rrIndex + 1) % AGENTS.length;
  saveState();
  return agent;
}

async function pushToDashboard(event, session) {
  const payload = {
    event, // lead.created | lead.qualified | lead.stalled | lead.asset_requested
    sentAt: new Date().toISOString(),
    lead: {
      phone: session.phone,
      name: session.name || null,
      project: session.project || DEFAULT_PROJECT,
      source: session.source || 'whatsapp',
      facing: session.facing || null,
      unitSize: session.unitSize || null,
      budget: session.budget || null,
      track: session.track || (isDomesticNumber(session.phone) ? 'domestic' : 'overseas'),
      siteVisit: session.visitDay
        ? { type: session.visitType, day: session.visitDay }
        : null,
      videoCallRequested: session.videoCall ?? null,
      stage: session.stage,
      createdAt: session.createdAt ? new Date(session.createdAt).toISOString() : null,
      completedAt: session.completedAt ? new Date(session.completedAt).toISOString() : null,
      assetsSent: session.assetsSent || [],
      transcript: session.transcript || []
    },
    agent: session.agent || null
  };

  console.log(`[dashboard] ${event} -> ${session.phone} (agent: ${session.agent?.name || 'none'})`);
  if (!DASHBOARD_WEBHOOK_URL) return;

  try {
    await fetch(DASHBOARD_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(DASHBOARD_WEBHOOK_SECRET ? { 'X-Webhook-Secret': DASHBOARD_WEBHOOK_SECRET } : {})
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('[dashboard] push failed:', e.message);
  }
}

// ===========================================================================
// SESSION HELPERS
// ===========================================================================
function getSession(phone) {
  const p = cleanPhone(phone);
  if (!store.sessions[p]) {
    store.sessions[p] = {
      phone: p,
      stage: STAGES.OPENER_SENT,
      createdAt: now(),
      updatedAt: now(),
      transcript: [],
      assetsSent: [],
      stepNudges: 0
    };
  }
  return store.sessions[p];
}

function log(session, role, text) {
  session.transcript = session.transcript || [];
  session.transcript.push({ role, text, at: new Date().toISOString() });
  if (session.transcript.length > 60) session.transcript = session.transcript.slice(-60);
  session.updatedAt = now();
  saveState();
}

function clearNudge(phone) {
  const t = timers.get(cleanPhone(phone));
  if (t) { clearTimeout(t); timers.delete(cleanPhone(phone)); }
}

function scheduleNudge(phone, ms, fn) {
  clearNudge(phone);
  const p = cleanPhone(phone);
  const t = setTimeout(() => { withLock(p, fn).catch((e) => console.error('[nudge]', e)); }, ms);
  if (t.unref) t.unref();
  timers.set(p, t);
}

// ===========================================================================
// FLOW — question senders
// ===========================================================================
/** Only reset the nudge counter when the stage genuinely advances. */
function setStage(session, stage) {
  if (session.stage !== stage) session.stepNudges = 0;
  session.stage = stage;
}

async function askQ1(session) {
  setStage(session, STAGES.Q1_FACING);
  await sendOptions(session.phone, SCRIPT.q1_facing.body, SCRIPT.q1_facing.options);
  log(session, 'assistant', SCRIPT.q1_facing.body);
  armStepNudge(session);
}

async function askQ2(session) {
  const opts = SCRIPT.q2_size.byFacing[session.facingId];
  setStage(session, STAGES.Q2_SIZE);
  await sendOptions(session.phone, SCRIPT.q2_size.body, opts, 'View sizes');
  log(session, 'assistant', SCRIPT.q2_size.body);
  armStepNudge(session);
}

async function askQ3(session) {
  setStage(session, STAGES.Q3_BUDGET);
  await sendOptions(session.phone, SCRIPT.q3_budget.body, SCRIPT.q3_budget.options, 'View budgets');
  log(session, 'assistant', SCRIPT.q3_budget.body);
  armStepNudge(session);
}

async function askQ4(session) {
  setStage(session, STAGES.Q4_VISIT_TYPE);
  const pitch = USE_ORIGINAL_PITCH ? SCRIPT.visitPitchOriginal : SCRIPT.visitPitch;
  await sendText(session.phone, pitch);
  log(session, 'assistant', pitch);
  await sleep(TYPING_DELAY_MS);
  await sendOptions(session.phone, SCRIPT.q4_visit_type.body, SCRIPT.q4_visit_type.options);
  log(session, 'assistant', SCRIPT.q4_visit_type.body);
  armStepNudge(session);
}

async function askQ5(session) {
  setStage(session, STAGES.Q5_DAY);
  const opts = SCRIPT.q5_day[session.visitType === 'weekend' ? 'weekend' : 'weekday'];
  await sendOptions(session.phone, SCRIPT.q5_day.body, opts, 'Pick a day');
  log(session, 'assistant', SCRIPT.q5_day.body);
  armStepNudge(session);
}

/** Re-send the question for whatever stage the lead is currently on. */
async function reaskCurrent(session) {
  switch (session.stage) {
    case STAGES.OPENER_SENT:
    case STAGES.INTRO_SENT:
    case STAGES.Q1_FACING: return askQ1(session);
    case STAGES.Q2_SIZE:   return askQ2(session);
    case STAGES.Q3_BUDGET: return askQ3(session);
    case STAGES.Q4_VISIT_TYPE: {
      await sendOptions(session.phone, SCRIPT.q4_visit_type.body, SCRIPT.q4_visit_type.options);
      log(session, 'assistant', SCRIPT.q4_visit_type.body);
      return armStepNudge(session);
    }
    case STAGES.Q5_DAY:    return askQ5(session);
    case STAGES.NRI_VIDEO_CALL:
      await sendOptions(session.phone, SCRIPT.nri.videoCallAsk.body, SCRIPT.nri.videoCallAsk.options);
      log(session, 'assistant', SCRIPT.nri.videoCallAsk.body);
      return armStepNudge(session);
    default: return null;
  }
}

/** Silence mid-flow -> nudge up to MAX_STEP_NUDGES, then park the lead. */
function armStepNudge(session) {
  scheduleNudge(session.phone, NUDGE_STEP_MS, async () => {
    const s = store.sessions[session.phone];
    if (!s || s.stage === STAGES.COMPLETED || s.stage === STAGES.STALLED) return;
    if (!withinServiceWindow(s)) return; // cannot free-form message outside 24h

    if ((s.stepNudges || 0) >= MAX_STEP_NUDGES) {
      s.stage = STAGES.STALLED;
      await sendText(s.phone, SCRIPT.stalled);
      log(s, 'assistant', SCRIPT.stalled);
      await pushToDashboard('lead.stalled', s);
      return;
    }
    s.stepNudges = (s.stepNudges || 0) + 1;
    await reaskCurrent(s);
  });
}

/** Overseas lead: no site visit. Pitch, send the walkthrough, close. */
async function runNriPath(session) {
  clearNudge(session.phone);
  session.track = 'overseas';

  await sendText(session.phone, SCRIPT.nri.pitch);
  log(session, 'assistant', SCRIPT.nri.pitch);
  await sleep(TYPING_DELAY_MS);

  await sendAsset(session.phone, ASSETS.walkthrough);
  session.assetsSent = Array.from(new Set([...(session.assetsSent || []), 'walkthrough']));
  log(session, 'assistant', '[sent asset: walkthrough]');
  await sleep(TYPING_DELAY_MS);

  await sendText(session.phone, SCRIPT.nri.afterVideo);
  log(session, 'assistant', SCRIPT.nri.afterVideo);

  if (NRI_ASK_VIDEO_CALL) {
    await sleep(TYPING_DELAY_MS);
    setStage(session, STAGES.NRI_VIDEO_CALL);
    await sendOptions(session.phone, SCRIPT.nri.videoCallAsk.body, SCRIPT.nri.videoCallAsk.options);
    log(session, 'assistant', SCRIPT.nri.videoCallAsk.body);
    return armStepNudge(session);
  }
  return closeAndHandOff(session);
}

/** The two closing messages + agent assignment + dashboard push. */
async function closeAndHandOff(session) {
  clearNudge(session.phone);
  session.stage = STAGES.COMPLETED;
  session.completedAt = now();

  await sendText(session.phone, SCRIPT.done1);
  log(session, 'assistant', SCRIPT.done1);
  await sleep(TYPING_DELAY_MS);
  await sendText(session.phone, SCRIPT.done2);
  log(session, 'assistant', SCRIPT.done2);

  if (!session.agent) session.agent = assignAgentRoundRobin();
  saveState();
  await pushToDashboard('lead.qualified', session);
}

async function completeLead(session, dayOption) {
  session.visitDay = dayOption.title;
  session.track = 'domestic';
  return closeAndHandOff(session);
}

// ===========================================================================
// FLOW — out-of-flow handling
// ===========================================================================
/**
 * Returns true if the message was handled off-flow (asset or LLM answer).
 * Always re-asks the current question afterwards.
 */
async function handleOutOfFlow(session, text) {
  const hit = detectAsset(text);

  if (hit) {
    await sendAsset(session.phone, hit.asset);
    session.assetsSent = Array.from(new Set([...(session.assetsSent || []), hit.key]));
    log(session, 'assistant', `[sent asset: ${hit.key}]`);
    await pushToDashboard('lead.asset_requested', session);
    await sleep(TYPING_DELAY_MS);
    await reaskCurrent(session);
    return true;
  }

  const answer = await llmAnswer(session, text);
  if (answer) {
    await sendText(session.phone, answer);
    log(session, 'assistant', answer);
    await sleep(TYPING_DELAY_MS);
    await reaskCurrent(session);
    return true;
  }

  // No LLM configured — nudge back to the options.
  await sendText(session.phone, SCRIPT.reprompt);
  log(session, 'assistant', SCRIPT.reprompt);
  await sleep(TYPING_DELAY_MS);
  await reaskCurrent(session);
  return true;
}

// ===========================================================================
// FLOW — main router
// ===========================================================================
async function handleInbound(session, text) {
  clearNudge(session.phone);
  session.stepNudges = 0;

  const norm = text.trim().toLowerCase();

  // Hard restart
  if (['restart', 'start over', 'menu', 'reset'].includes(norm)) {
    session.facing = session.facingId = session.unitSize = null;
    session.budget = session.visitType = session.visitDay = null;
    return askQ1(session);
  }

  switch (session.stage) {

    // -------- after "Hi {name}, how are you?" ----------------------------
    case STAGES.OPENER_SENT: {
      if (matchesAny(norm, WHO_IS_THIS)) {
        const intro = SCRIPT.intro(session.project || DEFAULT_PROJECT);
        await sendText(session.phone, intro);
        log(session, 'assistant', intro);
        session.stage = STAGES.INTRO_SENT;
        // give them a beat to react, then ask Q1 anyway
        scheduleNudge(session.phone, NUDGE_INTRO_MS, async () => {
          const s = store.sessions[session.phone];
          if (s && s.stage === STAGES.INTRO_SENT) await askQ1(s);
        });
        return;
      }
      // If they opened with a real question, answer it first, then ask Q1.
      if (detectAsset(norm) || norm.includes('?') || norm.length > 25) {
        return handleOutOfFlow(session, text);
      }
      await sleep(TYPING_DELAY_MS);
      return askQ1(session);
    }

    // -------- after persona intro ----------------------------------------
    case STAGES.INTRO_SENT: {
      if (detectAsset(norm) || norm.includes('?')) return handleOutOfFlow(session, text);
      await sleep(TYPING_DELAY_MS);
      return askQ1(session);
    }

    // -------- Q1 facing ---------------------------------------------------
    case STAGES.Q1_FACING: {
      const opt = matchOption(text, SCRIPT.q1_facing.options);
      if (!opt) return handleOutOfFlow(session, text);

      session.facingId = opt.id;
      session.facing = opt.title;

      if (opt.id === 'west') {
        session.unitSize = SCRIPT.q2_size.westSizeLabel;
        await sendText(session.phone, SCRIPT.q2_size.westStatement);
        log(session, 'assistant', SCRIPT.q2_size.westStatement);
        await sleep(TYPING_DELAY_MS);
        return askQ3(session);
      }
      return askQ2(session);
    }

    // -------- Q2 unit size ------------------------------------------------
    case STAGES.Q2_SIZE: {
      const opts = SCRIPT.q2_size.byFacing[session.facingId] || [];
      const opt = matchOption(text, opts);
      if (!opt) return handleOutOfFlow(session, text);
      session.unitSize = opt.title;
      return askQ3(session);
    }

    // -------- Q3 budget ---------------------------------------------------
    case STAGES.Q3_BUDGET: {
      const opt = matchOption(text, SCRIPT.q3_budget.options);
      if (!opt) return handleOutOfFlow(session, text);
      session.budget = opt.title;
      // Overseas numbers skip the site visit entirely.
      return isDomesticNumber(session.phone) ? askQ4(session) : runNriPath(session);
    }

    // -------- Q4 weekday / weekend ---------------------------------------
    case STAGES.Q4_VISIT_TYPE: {
      const opt = matchOption(text, SCRIPT.q4_visit_type.options);
      if (!opt) return handleOutOfFlow(session, text);
      session.visitType = opt.id;
      return askQ5(session);
    }

    // -------- Q5 day ------------------------------------------------------
    case STAGES.Q5_DAY: {
      const opts = SCRIPT.q5_day[session.visitType === 'weekend' ? 'weekend' : 'weekday'];
      const opt = matchOption(text, opts);
      if (!opt) return handleOutOfFlow(session, text);
      return completeLead(session, opt);
    }

    // -------- overseas: optional video call ------------------------------
    case STAGES.NRI_VIDEO_CALL: {
      const opt = matchOption(text, SCRIPT.nri.videoCallAsk.options);
      if (!opt) return handleOutOfFlow(session, text);
      session.videoCall = opt.id === 'vc_yes';
      const reply = session.videoCall ? SCRIPT.nri.videoCallYes : SCRIPT.nri.videoCallNo;
      await sendText(session.phone, reply);
      log(session, 'assistant', reply);
      await sleep(TYPING_DELAY_MS);
      return closeAndHandOff(session);
    }

    // -------- after completion / stalled ----------------------------------
    case STAGES.COMPLETED:
    case STAGES.STALLED:
    default: {
      const hit = detectAsset(norm);
      if (hit) {
        await sendAsset(session.phone, hit.asset);
        session.assetsSent = Array.from(new Set([...(session.assetsSent || []), hit.key]));
        log(session, 'assistant', `[sent asset: ${hit.key}]`);
        return pushToDashboard('lead.asset_requested', session);
      }
      const answer = await llmAnswer(session, text);
      const reply = answer || SCRIPT.fallbackGeneric;
      await sendText(session.phone, reply);
      log(session, 'assistant', reply);
      return;
    }
  }
}

// ===========================================================================
// EXPRESS
// ===========================================================================
const app = express();

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Headers', 'Origin, Content-Type, Accept, Authorization, X-Api-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // not configured — open (set API_KEY in production)
  const given = req.get('X-Api-Key') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (given !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function verifyMetaSignature(req) {
  if (!APP_SECRET) return true; // not configured — skip (set APP_SECRET in production)
  const sig = req.get('X-Hub-Signature-256');
  if (!sig || !req.rawBody) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

app.get('/', (_req, res) =>
  res.status(200).send('Raghava Speed-to-Lead WhatsApp Assistant — online.')
);

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    sessions: Object.keys(store.sessions).length,
    agents: AGENTS.length,
    llm: Boolean(ANTHROPIC_API_KEY),
    uptimeSec: Math.round(process.uptime())
  })
);

// --- Meta webhook verification --------------------------------------------
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ===========================================================================
// OUTBOUND TRIGGER — call this the second a lead lands
// POST /api/trigger-lead
// { "name": "Suresh", "phone": "919000000000", "project": "Linq",
//   "source": "meta_lead_ad" }
// ===========================================================================
app.post('/api/trigger-lead', requireApiKey, async (req, res) => {
  const { name, phone, project, source } = req.body || {};
  const p = cleanPhone(phone);
  if (!p) return res.status(400).json({ error: 'phone is required' });

  // fresh session for a re-triggered lead
  delete store.sessions[p];
  const session = getSession(p);
  session.name = name || null;
  session.project = project || DEFAULT_PROJECT;
  session.source = source || 'api';
  session.stage = STAGES.OPENER_SENT;
  session.agent = assignAgentRoundRobin();   // owned by an agent from message one

  const opener = SCRIPT.opener(name);

  try {
    // Cold contact: Meta requires an approved template outside the 24h window.
    if (OPENER_TEMPLATE_NAME) {
      await sendTemplate(p, OPENER_TEMPLATE_NAME, OPENER_TEMPLATE_LANG, [name || 'there']);
    } else {
      // Works only if this number messaged you in the last 24h.
      await sendText(p, opener);
    }
    log(session, 'assistant', opener);
    await pushToDashboard('lead.created', session);

    // "If they don't reply in a minute or two, send the question automatically."
    scheduleNudge(p, NUDGE_OPENER_MS, async () => {
      const s = store.sessions[p];
      if (!s || s.stage !== STAGES.OPENER_SENT) return;
      if (withinServiceWindow(s)) {
        await askQ1(s);
      } else if (NUDGE_TEMPLATE_NAME) {
        await sendTemplate(p, NUDGE_TEMPLATE_NAME, NUDGE_TEMPLATE_LANG, [name || 'there']);
        log(s, 'assistant', '[nudge template sent]');
      } else {
        // No template configured. Meta will reject this outside the 24h window
        // (error 131047) — the attempt is made so it still works in testing.
        console.warn(`[nudge] ${p} has not replied and NUDGE_TEMPLATE_NAME is unset — attempting free-form.`);
        await askQ1(s);
      }
    });

    return res.status(200).json({
      success: true,
      phone: p,
      assignedAgent: session.agent || null
    });
  } catch (e) {
    console.error('[trigger] failed:', e);
    return res.status(500).json({ error: 'failed to start WhatsApp flow' });
  }
});

// ===========================================================================
// INBOUND WEBHOOK
// ===========================================================================
app.post('/webhook', async (req, res) => {
  if (!verifyMetaSignature(req)) {
    trace('webhookLog', { kind: 'REJECTED_BAD_SIGNATURE' });
    console.warn('[webhook] bad signature — check APP_SECRET matches the Meta app');
    return res.sendStatus(403);
  }
  res.status(200).send('EVENT_RECEIVED'); // ack immediately, process after

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const value = body.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    const statusEvt = value?.statuses?.[0];

    trace('webhookLog', {
      kind: msg ? 'message' : statusEvt ? `status:${statusEvt.status}` : 'other',
      from: msg?.from || statusEvt?.recipient_id || null,
      msgType: msg?.type || null,
      error: statusEvt?.errors?.[0]
        ? `${statusEvt.errors[0].code}: ${statusEvt.errors[0].title}`
        : null
    });

    if (!msg) return; // status callbacks (sent/delivered/read) land here too

    const from = cleanPhone(msg.from);
    const messageId = msg.id;

    // Meta retries webhooks — drop duplicates
    if (store.seenMessages[messageId]) return;
    store.seenMessages[messageId] = now();

    // Extract text from every reply type
    let text = '';
    if (msg.type === 'text') text = msg.text?.body || '';
    else if (msg.type === 'interactive') {
      text = msg.interactive?.button_reply?.id
          || msg.interactive?.list_reply?.id
          || msg.interactive?.button_reply?.title
          || msg.interactive?.list_reply?.title
          || '';
    } else if (msg.type === 'button') {
      text = msg.button?.payload || msg.button?.text || '';
    } else {
      text = `[${msg.type}]`; // image / audio / location etc.
    }

    await markAsRead(messageId);

    await withLock(from, async () => {
      const session = getSession(from);
      if (!session.name) {
        session.name = value?.contacts?.[0]?.profile?.name || session.name || null;
      }
      session.lastInboundAt = now();
      log(session, 'user', text);
      console.log(`[in] ${from} (${session.stage}): ${text}`);

      // Unsupported media -> let the LLM/asset layer deal with it politely
      await handleInbound(session, text);
      saveState();
    });
  } catch (err) {
    console.error('[webhook] runtime error:', err);
  }
});

// ===========================================================================
// READ APIs (for the agent dashboard)
// ===========================================================================
app.get('/api/leads', requireApiKey, (req, res) => {
  const { stage, agentId } = req.query;
  const leads = Object.values(store.sessions)
    .filter((s) => (stage ? s.stage === stage : true))
    .filter((s) => (agentId ? s.agent?.id === agentId : true))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((s) => ({
      phone: s.phone,
      name: s.name,
      project: s.project,
      stage: s.stage,
      facing: s.facing,
      unitSize: s.unitSize,
      budget: s.budget,
      track: s.track || (isDomesticNumber(s.phone) ? 'domestic' : 'overseas'),
      siteVisit: s.visitDay ? { type: s.visitType, day: s.visitDay } : null,
      agent: s.agent,
      assetsSent: s.assetsSent,
      updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null
    }));
  res.json({ count: leads.length, leads });
});

app.get('/api/leads/:phone', requireApiKey, (req, res) => {
  const s = store.sessions[cleanPhone(req.params.phone)];
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s);
});

// Is Meta actually calling us? This is the first thing to check when
// "the first message sent but nothing came after".
app.get('/api/debug/webhook-log', requireApiKey, (_req, res) =>
  res.json({
    hits: store.webhookLog.length,
    lastHitAt: store.webhookLog[0]?.at || null,
    log: store.webhookLog
  })
);

// Did our outbound sends succeed, and what did Meta say if not?
app.get('/api/debug/send-log', requireApiKey, (_req, res) =>
  res.json({ log: store.sendLog })
);

// Run the flow without WhatsApp: replays text through the state machine.
app.post('/api/debug/simulate', requireApiKey, async (req, res) => {
  const { phone, text, stage, reset } = req.body || {};
  const p = cleanPhone(phone || '910000000000');
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (reset) { clearNudge(p); delete store.sessions[p]; }
  const before = store.sendLog.length;
  await withLock(p, async () => {
    const s = getSession(p);
    // Sessions start at OPENER_SENT (waiting on "how are you?"), so pass
    // {"stage":"Q1_FACING"} to jump straight into the questionnaire.
    if (stage && STAGES[stage]) s.stage = STAGES[stage];
    s.lastInboundAt = now();
    log(s, 'user', text);
    await handleInbound(s, text);
  });
  res.json({
    session: store.sessions[p],
    sendsAttempted: store.sendLog.length - before
  });
});

app.get('/api/agents', requireApiKey, (_req, res) =>
  res.json({ agents: AGENTS, nextIndex: store.rrIndex })
);

// Manual handover — stop the bot for a lead so a human can take over
app.post('/api/leads/:phone/handover', requireApiKey, async (req, res) => {
  const p = cleanPhone(req.params.phone);
  const s = store.sessions[p];
  if (!s) return res.status(404).json({ error: 'not found' });
  clearNudge(p);
  s.stage = STAGES.COMPLETED;
  saveState();
  await pushToDashboard('lead.qualified', s);
  res.json({ success: true });
});

// ===========================================================================
// HOUSEKEEPING
// ===========================================================================
setInterval(() => {
  const cutoff = now() - SESSION_TTL_MS;
  for (const [p, s] of Object.entries(store.sessions)) {
    if ((s.updatedAt || 0) < cutoff) { clearNudge(p); delete store.sessions[p]; }
  }
  const msgCutoff = now() - 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(store.seenMessages)) {
    if (ts < msgCutoff) delete store.seenMessages[id];
  }
  saveState();
}, 30 * 60 * 1000).unref?.();

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

app.listen(PORT, () => {
  console.log(`\nRaghava Speed-to-Lead assistant listening on ${PORT}`);
  console.log(`  node ${process.version} | agents ${AGENTS.length} | llm ${ANTHROPIC_API_KEY ? LLM_MODEL : 'DISABLED'}`);

  const fatal = [];
  const warn = [];
  if (!META_ACCESS_TOKEN) fatal.push('META_ACCESS_TOKEN missing — cannot send anything');
  if (!PHONE_NUMBER_ID) fatal.push('PHONE_NUMBER_ID missing — cannot send anything');
  if (!VERIFY_TOKEN) fatal.push('VERIFY_TOKEN missing — Meta webhook verification will fail');
  if (!OPENER_TEMPLATE_NAME) fatal.push('OPENER_TEMPLATE_NAME missing — cold opens will be rejected (error 131047)');
  if (!APP_SECRET) warn.push('APP_SECRET unset — webhook signatures are NOT verified');
  if (!API_KEY) warn.push('API_KEY unset — /api routes are public');
  if (!AGENTS.length) warn.push('AGENTS empty — no round-robin assignment will happen');
  if (!DASHBOARD_WEBHOOK_URL) warn.push('DASHBOARD_WEBHOOK_URL unset — leads log to console only');
  if (!ANTHROPIC_API_KEY) warn.push('ANTHROPIC_API_KEY unset — out-of-flow questions get a canned reply');
  if (!ASSETS.brochure.url) warn.push('ASSET_BROCHURE_URL unset — brochure requests cannot be fulfilled');

  fatal.forEach((m) => console.error('  ⛔ ' + m));
  warn.forEach((m) => console.warn('  ⚠  ' + m));
  if (!fatal.length && !warn.length) console.log('  ✅ config complete');
  console.log('');
});

module.exports = app;
