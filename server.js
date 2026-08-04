/**
 * SPECIAL CARGO SERVICES — backend (single file)
 * ------------------------------------------------
 * Serves the website (static files in /public) and exposes two API routes:
 *
 *   POST /api/chat   → AI Cargo Assistant (real Google Gemini API integration)
 *   POST /api/rfq    → RFQ form submission (saves it + notifies Telegram & Email)
 *
 * WHAT YOU NEED TO FILL IN (see the ".env" section below / .env.example):
 *   1) GEMINI_API_KEY           — Google Gemini API key (aistudio.google.com/apikey)
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
const multer = require('multer');
const { Pool } = require('pg');
require('dotenv').config();

// -------------------------------------------------------------------------
// File attachments (AI Cargo Assistant) — clients can attach a packing
// list, invoice, MSDS / safety data sheet, or other shipment document.
// Kept in memory only (never written to disk) and sent straight to the
// Gemini API + Telegram; nothing is persisted beyond the request.
// -------------------------------------------------------------------------
const ALLOWED_ATTACHMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_ATTACHMENT_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
    cb(new Error('unsupported_file_type'));
  },
});

const {
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-2.0-flash',
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
// Telegram: forward a client-attached document (packing list, invoice,
// MSDS, etc.) to the ops chat as-is, so managers have the original file.
// -------------------------------------------------------------------------
async function sendTelegramDocument(buffer, filename, mimetype, caption) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;
    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('caption', caption || '');
    form.append('parse_mode', 'HTML');
    form.append('document', new Blob([buffer], { type: mimetype }), filename);
    const res = await fetch(url, { method: 'POST', body: form });
    if (!res.ok) {
      console.error('[telegram] sendDocument failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[telegram] sendDocument error:', err);
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
// Pretty HTML email builder for RFQ notifications
// -------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const URGENCY_LABELS = {
  express: { label: '🔴 Express (shoshilinch)', color: '#dc2626' },
  standard: { label: '🟡 Standard', color: '#d97706' },
  economy: { label: '🟢 Economy (shoshilmas)', color: '#16a34a' },
};

function buildRfqEmailHtml(rfq) {
  const urgencyInfo = URGENCY_LABELS[String(rfq.urgency).toLowerCase()] || {
    label: rfq.urgency || '—',
    color: '#64748b',
  };

  const row = (label, value) =>
    value
      ? `<tr>
           <td style="padding:10px 16px;color:#64748b;font-size:13px;font-weight:600;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
           <td style="padding:10px 16px;color:#0f172a;font-size:14px;">${escapeHtml(value)}</td>
         </tr>`
      : '';

  return `
  <div style="background:#f1f5f9;padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">

      <div style="background:#0f172a;padding:24px 28px;">
        <p style="margin:0;color:#94a3b8;font-size:12px;letter-spacing:0.05em;text-transform:uppercase;">Special Cargo Services</p>
        <h1 style="margin:6px 0 0;color:#ffffff;font-size:20px;">🆕 Yangi tarif so'rovi (RFQ)</h1>
        <p style="margin:6px 0 0;color:#cbd5e1;font-size:13px;">${escapeHtml(rfq.id)} · ${new Date(rfq.receivedAt || Date.now()).toLocaleString('uz-UZ')}</p>
      </div>

      <div style="padding:8px 12px;">
        <div style="display:inline-block;margin:16px 16px 0;padding:6px 14px;border-radius:999px;background:${urgencyInfo.color}1a;color:${urgencyInfo.color};font-size:13px;font-weight:700;">
          ${urgencyInfo.label}
        </div>

        <table style="width:100%;border-collapse:collapse;margin-top:8px;">
          ${row('👤 Mijoz', rfq.fullName)}
          ${row('🏢 Kompaniya', rfq.company)}
          ${row('📞 Telefon', rfq.phone)}
          ${row('✉️ Email', rfq.email)}
          ${row('📍 Qayerdan', rfq.origin)}
          ${row('📍 Qayerga', rfq.destination)}
          ${row('📦 Yuk turi', rfq.cargoType)}
          ${row('⚖️ Og\'irligi', rfq.weight ? `${rfq.weight} kg` : '')}
          ${row('🔢 Dona soni', rfq.pieces)}
          ${row('📐 O\'lchamlari', rfq.dimensions)}
          ${row('📄 Incoterms', rfq.incoterms)}
          ${row('📅 Tayyor sana', rfq.cargoReadyDate)}
          ${row('⚠️ Maxsus talablar', rfq.specialRequirements)}
          ${row('📝 Tavsif', rfq.cargoDescription || rfq.summary)}
          ${row('📥 Manba', rfq.source === 'ai_assistant' ? 'AI Cargo Assistant' : 'Sayt formasi')}
        </table>
      </div>

      <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;">
        <p style="margin:0;color:#94a3b8;font-size:12px;">Bu xabar specialcargo.uz saytidan avtomatik yuborildi.</p>
      </div>
    </div>
  </div>`;
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
        `Yangi so'rov — ${rfq.fullName} (${rfq.id})`,
        buildRfqEmailHtml(rfq)
      ),
    ]);

    res.json({ ok: true, id: rfq.id });
  } catch (err) {
    console.error('[rfq] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// =========================================================================
// POST /api/chat — AI Cargo Assistant (Google Gemini API)
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
5a. The client may attach a document (packing list, commercial invoice, MSDS / safety data sheet,
   or another shipment document) as a PDF or image. When a document is attached, read it carefully
   and automatically extract whatever is relevant: origin/destination, cargo type (including
   dangerous goods class if it's an MSDS), weight, dimensions, number of pieces, and any special
   handling requirements. Confirm back to the user in 1-2 lines what you extracted from the
   document, then ask ONLY for whatever required details are still missing — do not re-ask for
   anything already visible in the document.
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

app.post('/api/chat', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const code = err.message === 'unsupported_file_type' ? 'unsupported_file_type' : 'file_too_large';
      return res.status(400).json({ error: code });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server' });
    }

    // Frontend sends FormData: `messages` is a JSON string, `lang` a plain
    // string, and `file` (optional) the attached document/image.
    let messages = [];
    try {
      const raw = req.body && req.body.messages;
      messages = raw ? JSON.parse(raw) : [];
    } catch (err) {
      return res.status(400).json({ error: 'invalid_messages' });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required' });
    }
    const lang = (req.body && req.body.lang) || 'ru';

    // Gemini's `contents` format uses role "user" / "model" (not
    // "assistant"), and each turn is an array of "parts".
    const geminiContents = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(m.content).slice(0, 4000) }],
      }))
      .slice(-20); // keep last 20 turns max

    // If a document was attached, attach it (as inline base64 data) to the
    // LAST turn only (the one that came in with it), so Gemini reads it
    // directly — Gemini supports images and PDFs as inline_data natively.
    const file = req.file;
    if (file && geminiContents.length > 0) {
      const lastIdx = geminiContents.length - 1;
      const base64Data = file.buffer.toString('base64');
      geminiContents[lastIdx].parts.push({
        inline_data: { mime_type: file.mimetype, data: base64Data },
      });

      // Forward the original document to Telegram right away so a human
      // has it too, independent of whether the AI later files a full RFQ.
      sendTelegramDocument(
        file.buffer,
        file.originalname || 'attachment',
        file.mimetype,
        '📎 <b>Mijoz AI Assistant orqali hujjat yubordi</b>'
      ).catch((err) => console.error('[chat] telegram document forward error:', err));
    }

    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: geminiContents,
          generationConfig: { maxOutputTokens: 600 },
        }),
      }
    );

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('[chat] Gemini API error:', apiRes.status, errText);
      return res.status(502).json({ error: 'ai_provider_error' });
    }

    const data = await apiRes.json();
    const rawText = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [])
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text)
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
        sendEmailNotification(`Yangi so'rov — AI Assistant (${rfqRecord.id})`, buildRfqEmailHtml(rfqRecord)),
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
