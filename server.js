/**
 * SPECIAL CARGO SERVICES — backend (single file)
 * ------------------------------------------------
 * Serves the website (static files in /public) and exposes two API routes:
 *
 *   POST /api/chat   → AI Cargo Assistant (real Claude API integration)
 *   POST /api/rfq    → RFQ form submission (saves it + notifies Telegram & Email)
 *
 * WHAT YOU NEED TO FILL IN (see the ".env" section below / .env.example):
 *   1) ANTHROPIC_API_KEY        — Claude API key (console.anthropic.com)
 *   2) TELEGRAM_BOT_TOKEN       — Telegram bot token (from @BotFather)
 *   3) TELEGRAM_CHAT_ID         — chat/group/channel id that should receive RFQs
 *   4) RESEND_API_KEY           — Resend API key (resend.com) — used to send emails over HTTPS
 *                                 (works even on hosts like Railway that block outbound SMTP)
 *   5) RESEND_FROM              — sender address. In TEST MODE (no verified domain), use
 *                                 "onboarding@resend.dev" — Resend will then only deliver to
 *                                 the email address you signed up to Resend with.
 *   6) NOTIFY_EMAIL_TO          — where RFQ emails should be delivered
 *   7) (optional) RECAPTCHA_SECRET_KEY — if you turn reCAPTCHA v3 verification on
 *
 * Run:
 *   npm install
 *   cp .env.example .env      # then fill in the values above
 *   npm start
 */

const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = 'claude-sonnet-4-20250514',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  RESEND_API_KEY,
  RESEND_FROM = 'onboarding@resend.dev', // test mode default — swap once your domain is verified
  NOTIFY_EMAIL_TO,
  RECAPTCHA_SECRET_KEY,
  DATABASE_URL = 'postgresql://postgres:LNCBjskDZtgwoRMOxSHiNYHMuIemTVwQ@sakura.proxy.rlwy.net:28926/railway',
  ALLOWED_ORIGIN = '*', // set to your Netlify URL in production, e.g. https://asliddinx212.netlify.app
  PORT = 3000,
} = process.env;

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map((s) => s.trim()) }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------------------
// PostgreSQL storage — all RFQ / AI Assistant leads are saved here.
// Connection string comes from DATABASE_URL (.env) and defaults to the
// Railway Postgres instance given by the client.
// -------------------------------------------------------------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required by Railway's managed Postgres
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rfq_submissions (
      id                    SERIAL PRIMARY KEY,
      request_id            TEXT UNIQUE NOT NULL,
      received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      source                TEXT NOT NULL,            -- 'rfq_form' | 'ai_assistant'
      lang                  TEXT,
      full_name             TEXT,
      company               TEXT,
      phone                 TEXT,
      email                 TEXT,
      origin                TEXT,
      destination           TEXT,
      cargo_type            TEXT,
      weight                TEXT,
      pieces                TEXT,
      dimensions            TEXT,
      incoterms             TEXT,
      urgency               TEXT,
      cargo_ready_date      TEXT,
      special_requirements  TEXT,
      cargo_description     TEXT,
      summary               TEXT,
      raw_payload           JSONB
    );
  `);
  console.log('[db] rfq_submissions table ready');
}

async function saveRfqToDb(rfq) {
  await pool.query(
    `INSERT INTO rfq_submissions
      (request_id, source, lang, full_name, company, phone, email, origin, destination,
       cargo_type, weight, pieces, dimensions, incoterms, urgency, cargo_ready_date,
       special_requirements, cargo_description, summary, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (request_id) DO NOTHING`,
    [
      rfq.id,
      rfq.source || 'rfq_form',
      rfq.lang || null,
      rfq.fullName || null,
      rfq.company || null,
      rfq.phone || null,
      rfq.email || null,
      rfq.origin || null,
      rfq.destination || null,
      rfq.cargoType || null,
      rfq.weight || null,
      rfq.pieces || null,
      rfq.dimensions || null,
      rfq.incoterms || null,
      rfq.urgency || null,
      rfq.cargoReadyDate || null,
      rfq.specialRequirements || null,
      rfq.cargoDescription || null,
      rfq.summary || null,
      JSON.stringify(rfq),
    ]
  );
}

// -------------------------------------------------------------------------
// Telegram notification
// -------------------------------------------------------------------------
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping Telegram notification');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
    if (!res.ok) {
      console.error('[telegram] failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[telegram] error:', err);
  }
}

// -------------------------------------------------------------------------
// Email notification (Resend HTTPS API — works even where outbound SMTP
// ports are blocked, e.g. Railway's Free/Trial/Hobby plans).
// TEST MODE: with RESEND_FROM=onboarding@resend.dev (no verified domain),
// Resend will only actually deliver to the email address you signed up
// with on Resend. Verify your own domain later to email anyone.
// -------------------------------------------------------------------------
if (!RESEND_API_KEY) {
  console.warn('[email] RESEND_API_KEY not set — skipping Email notification');
}

async function sendEmailNotification(subject, html) {
  if (!RESEND_API_KEY || !NOTIFY_EMAIL_TO) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `Special Cargo Services — Website <${RESEND_FROM}>`,
        to: NOTIFY_EMAIL_TO.split(',').map((s) => s.trim()),
        subject,
        html,
      }),
    });
    if (!res.ok) {
      console.error('[email] failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[email] error:', err);
  }
}

// -------------------------------------------------------------------------
// (Optional) reCAPTCHA v3 verification — call from /api/rfq if you enable it
// and add a `recaptchaToken` field on the frontend form.
// -------------------------------------------------------------------------
async function verifyRecaptcha(token) {
  if (!RECAPTCHA_SECRET_KEY) return true; // not configured → skip check
  if (!token) return false;
  try {
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${RECAPTCHA_SECRET_KEY}&response=${token}`,
    });
    const data = await res.json();
    return data.success && (data.score === undefined || data.score >= 0.5);
  } catch (err) {
    console.error('[recaptcha] error:', err);
    return false;
  }
}

// =========================================================================
// POST /api/rfq — RFQ form submission
// =========================================================================
app.post('/api/rfq', async (req, res) => {
  try {
    const body = req.body || {};

    if (body.recaptchaToken !== undefined) {
      const ok = await verifyRecaptcha(body.recaptchaToken);
      if (!ok) return res.status(400).json({ error: 'recaptcha_failed' });
    }

    if (!body.fullName || !body.phoneNumber) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    const rfq = {
      id: `RFQ-${Date.now()}`,
      receivedAt: new Date().toISOString(),
      lang: body.lang || 'ru',
      fullName: body.fullName || '',
      company: body.company || '',
      phone: `${body.phoneCountryCode || ''}${body.phoneNumber || ''}`,
      email: body.email || '',
      origin: body.origin || '',
      destination: body.destination || '',
      cargoType: body.cargoType || '',
      weight: body.weight || '',
      pieces: body.pieces || '',
      dimensions: body.dimensions || '',
      incoterms: body.incoterms || '',
      urgency: body.urgency || '',
      cargoReadyDate: body.cargoReadyDate || '',
      specialRequirements: body.specialRequirements || '',
      cargoDescription: body.cargoDescription || '',
      source: 'rfq_form',
    };

    await saveRfqToDb(rfq);

    const summaryText =
      `<b>🆕 New RFQ — ${rfq.id}</b>\n` +
      `👤 ${rfq.fullName}${rfq.company ? ' (' + rfq.company + ')' : ''}\n` +
      `📞 ${rfq.phone}${rfq.email ? ' · ' + rfq.email : ''}\n` +
      `📍 ${rfq.origin || '—'} → ${rfq.destination || '—'}\n` +
      `📦 ${rfq.cargoType || '—'} · ${rfq.weight || '?'} kg · ${rfq.pieces || '?'} pcs · ${rfq.dimensions || '—'}\n` +
      `⚡ Incoterms: ${rfq.incoterms || '—'} · Urgency: ${rfq.urgency || '—'} · Ready: ${rfq.cargoReadyDate || '—'}\n` +
      (rfq.specialRequirements ? `⚠️ ${rfq.specialRequirements}\n` : '') +
      (rfq.cargoDescription ? `📝 ${rfq.cargoDescription}\n` : '');

    await Promise.all([
      sendTelegramMessage(summaryText),
      sendEmailNotification(
        `New RFQ — ${rfq.fullName} (${rfq.id})`,
        `<pre style="font-family:monospace">${JSON.stringify(rfq, null, 2)}</pre>`
      ),
    ]);

    res.json({ ok: true, id: rfq.id });
  } catch (err) {
    console.error('[rfq] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// =========================================================================
// POST /api/chat — AI Cargo Assistant (Claude API)
// =========================================================================
const SYSTEM_PROMPT = `You are the "AI Cargo Assistant" for SPECIAL CARGO SERVICES (SCS), an
international air cargo & transit logistics company based in Tashkent, Uzbekistan (est. 2017).
SCS operates air freight, export from Uzbekistan, transit via Tashkent, Gulf & Middle East
logistics (UAE, Saudi Arabia, Qatar, Kuwait, Bahrain, Oman, Jordan, Israel), e-commerce logistics,
DG cargo, pharma logistics, airport handling, customs clearance, project cargo, CIS & Central Asia
distribution and charter solutions.

Your job in this chat:
1. Greet warmly and ask about the shipment: origin, destination, cargo type, weight/dimensions,
   number of pieces, urgency and readiness date.
2. Classify the cargo type (general / dangerous goods DG / pharma-GDP / valuable / e-commerce /
   project-oversized / live animals) based on what the user describes.
3. Ask concise follow-up questions ONE OR TWO AT A TIME until you have: route (from/to), cargo
   type, approximate weight, dimensions or pieces, and urgency/timing.
4. Reply in the SAME language the user is writing in. Support Russian and English fluently (and
   do your best in Uzbek or Chinese if the user writes in those).
5. Keep answers short, professional, friendly — this is a chat widget, not an essay.
6. Once you have gathered enough details to file a request (route + cargo type + weight/pieces),
   summarize it back to the user in 1-2 lines and tell them a manager will follow up within 2-4
   hours, and that the request has been forwarded to the team and Telegram.
7. On that final message ONLY, append on its own new line, exactly in this format (it will be
   stripped before the user sees it, so it must be machine-parseable):
   <<RFQ_READY>>{"origin":"...","destination":"...","cargoType":"...","weight":"...","pieces":"...","urgency":"...","summary":"one line human summary"}<<END>>
   Only emit this tag once per conversation, when you are confident you have enough information.
Never invent company data (pricing, transit times, phone numbers) that wasn't given to you here —
if asked for an exact quote, explain that a manager will confirm final pricing within 2-4 hours.`;

function extractRfqTag(text) {
  const match = text.match(/<<RFQ_READY>>([\s\S]*?)<<END>>/);
  if (!match) return { cleanText: text, rfq: null };
  const cleanText = text.replace(match[0], '').trim();
  let rfq = null;
  try {
    rfq = JSON.parse(match[1]);
  } catch (err) {
    console.error('[chat] failed to parse RFQ_READY tag:', err);
  }
  return { cleanText, rfq };
}

app.post('/api/chat', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });
    }

    const { messages = [] } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required' });
    }

    // Only forward role/content pairs Claude expects.
    const claudeMessages = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }))
      .slice(-20); // keep last 20 turns max

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: claudeMessages,
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('[chat] Anthropic API error:', apiRes.status, errText);
      return res.status(502).json({ error: 'ai_provider_error' });
    }

    const data = await apiRes.json();
    const rawText = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    const { cleanText, rfq } = extractRfqTag(rawText);

    if (rfq) {
      const rfqRecord = {
        id: `RFQ-CHAT-${Date.now()}`,
        receivedAt: new Date().toISOString(),
        source: 'ai_assistant',
        ...rfq,
      };
      await saveRfqToDb(rfqRecord);

      const summaryText =
        `<b>🤖 New RFQ from AI Cargo Assistant — ${rfqRecord.id}</b>\n` +
        `📍 ${rfq.origin || '—'} → ${rfq.destination || '—'}\n` +
        `📦 ${rfq.cargoType || '—'} · ${rfq.weight || '?'} kg · ${rfq.pieces || '?'} pcs\n` +
        `⚡ Urgency: ${rfq.urgency || '—'}\n` +
        `📝 ${rfq.summary || ''}`;

      // fire and forget — don't block the chat reply on notification delivery
      Promise.all([
        sendTelegramMessage(summaryText),
        sendEmailNotification(`New RFQ from AI Assistant — ${rfqRecord.id}`, `<pre>${JSON.stringify(rfqRecord, null, 2)}</pre>`),
      ]).catch((err) => console.error('[chat] notification error:', err));
    }

    res.json({ reply: cleanText, rfq_ready: Boolean(rfq) });
  } catch (err) {
    console.error('[chat] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Fallback: serve index.html for any other GET (simple SPA-friendly catch-all)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`SCS server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[db] failed to initialize database:', err);
    process.exit(1);
  });
