# Special Cargo Services — sayt + backend

## Tarkib
```
server.js        ← BUTUN backend (Express server) — 1 ta faylda
package.json
.env.example      ← nusxa oling → .env, keyin qiymatlarni to'ldiring
public/
  index.html      ← BUTUN frontend (Home + AI Assistant + Gulf & Middle East) — 1 ta faylda
  script.js
  style.css
  robots.txt
  sitemap.xml
```

## Ishga tushirish
```bash
npm install
cp .env.example .env     # keyin .env faylni to'ldiring (pastga qarang)
npm start                 # http://localhost:3000
```

## `.env` da to'ldirish kerak bo'lgan narsalar

| O'zgaruvchi | Nima uchun | Qayerdan olish |
|---|---|---|
| `ANTHROPIC_API_KEY` | AI Cargo Assistant (Claude API) ishlashi uchun | console.anthropic.com → API Keys |
| `TELEGRAM_BOT_TOKEN` | RFQ va AI chatdan kelgan buyurtmalarni Telegramga yuborish | Telegram: @BotFather → /newbot |
| `TELEGRAM_CHAT_ID` | Qaysi guruh/kanalga yuborilishi | Botni guruhga qo'shing, keyin `https://api.telegram.org/bot<TOKEN>/getUpdates` orqali `chat.id` ni ko'ring (yoki @userinfobot) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Email orqali xabar yuborish | Kompaniya pochtangiz (masalan Gmail App Password, Yandex, yoki boshqa SMTP provider) |
| `NOTIFY_EMAIL_TO` | RFQ xabarlari qaysi emailga tushishi kerak | Masalan info@specialcargo.uz |
| `RECAPTCHA_SECRET_KEY` | (ixtiyoriy) Formani botlardan himoya qilish | google.com/recaptcha → v3 |
| `PORT` | Server qaysi portda ishlashi | Odatda 3000 |

Hech qanday qiymat kiritilmasa ham server ishga tushadi — shunchaki tegishli
funksiya (Telegram/Email/AI) o'chirilgan bo'ladi va konsolda ogohlantirish chiqadi.

## API'lar
- `POST /api/chat` — AI Cargo Assistant xabar almashinuvi (Claude API orqali)
- `POST /api/rfq` — to'liq RFQ forma yuborilganda

Ikkalasi ham avtomatik ravishda so'rovni `data/rfq-log.jsonl` fayliga yozadi va
Telegram + Email orqali xabar yuboradi.

## Ma'lumotlar bazasi
Barcha RFQ (forma orqali va AI Assistant orqali kelgan) so'rovlar **PostgreSQL**
ga yoziladi — `DATABASE_URL` orqali beriladigan Railway bazasiga
(`rfq_submissions` jadvali server birinchi ishga tushganda avtomatik yaratiladi,
qo'lda migratsiya kerak emas).

## Eslatma
- Frontendda haqiqiy kontakt ma'lumotlari, logotip va aviakompaniya
  logolari hali placeholder — TZ ga ko'ra buni mijoz taqdim etadi.
- Bu konteynerdagi sandbox tarmog'i tashqi PostgreSQL/Telegram/SMTP xostlariga
  ruxsat bermagani uchun bazaga ulanishni shu yerda sinab bo'lmadi — kod to'g'ri
  yozilgan, real serverga (Railway, VPS va h.k.) joylashtirilganda internetga
  chiqish bo'lgani uchun ishlaydi.
