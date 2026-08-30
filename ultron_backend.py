"""
==================================================================
 ULTRON — Shaxsiy AI yordamchi backend (1-bosqich + 2-bosqich MVP)
==================================================================

Bu fayl quyidagilarni bajaradi:
  - Claude API bilan gaplashish (miya)
  - Suhbat tarixini bazada saqlash (xotira) — PostgreSQL (Railway) yoki
    mahalliy SQLite (agar DATABASE_URL berilmagan bo'lsa)
  - Eslatma qo'shish / ko'rish / o'chirish (Claude "tool" sifatida chaqiradi)
  - Telegram bot orqali ham gaplashish imkoni (bir xil miya/xotira)
  - Fon rejimida eslatmalarni tekshirib, vaqti kelganda bildirish
  - Telefon/kompyuter (Flutter) ilova ulanadigan HTTP API

MAHALLIY ISHGA TUSHIRISH (sinov uchun):
  1) Python 3.10+ kerak
  2) Terminalda:
       pip install fastapi uvicorn requests psycopg2-binary
  3) Quyidagi CONFIG bo'limiga o'z ma'lumotlaringizni yozing
     (yoki muhit o'zgaruvchisi orqali bering)
  4) Ishga tushirish:
       python ultron_backend.py
     Server manzili:  http://<kompyuter-ip>:8000

RAILWAY'GA JOYLASH:
  1) Loyihani GitHub'ga yuklang (shu ultron_backend.py va requirements.txt
     bilan — requirements.txt matnini shu fayl oxiridagi izohdan oling)
  2) Railway'da "New Project" -> "Deploy from GitHub repo"
  3) Railway'da "New" -> "Database" -> "PostgreSQL" qo'shing.
     Railway avtomatik ravishda DATABASE_URL muhit o'zgaruvchisini
     backend xizmatingizga ulaydi (Variables bo'limida ko'rasiz/
     "Reference" qilasiz).
  4) Railway "Variables" bo'limida quyidagilarni qo'shing:
       ANTHROPIC_API_KEY = sizning Claude API kalitingiz
       ULTRON_SECRET     = o'zingiz o'ylab topgan maxfiy kalit
       TELEGRAM_BOT_TOKEN (ixtiyoriy)
       TELEGRAM_ALLOWED_CHAT_ID (ixtiyoriy)
     PORT va DATABASE_URL'ni Railway o'zi avtomatik beradi — qo'lda
     kiritmang.
  5) "Start Command" sifatida quyidagini bering:
       python ultron_backend.py
  6) Deploy tugagach, Railway sizga ochiq URL beradi (masalan
     https://ultron-production.up.railway.app) — shuni Flutter ilova
     sozlamalariga "Backend manzili" sifatida kiritasiz.

XAVFSIZLIK:
  APP_SECRET — bu maxfiy kalit. Faqat shu kalitni bilgan ilova (sizning
  telefon/kompyuter ilovangiz) buyruq bera oladi. Buni hech kimga bermang.
"""

import os
import json
import threading
import time
import datetime
from typing import List, Optional

import requests
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

# ------------------------------------------------------------------
# 1) CONFIG — shu yerga o'zingizning ma'lumotlaringizni yozing
# ------------------------------------------------------------------

# Claude API kalitingiz (https://console.anthropic.com dan olingan)
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "BU_YERGA_CLAUDE_API_KEYINGIZNI_YOZING")

# Ishlatiladigan model
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5")

# Agar API kalitingiz "identity-linked" (bir nechta workspace'da ishlaydigan)
# turdagi bo'lsa, Claude API har bir so'rovda anthropic-workspace-id headerini
# talab qiladi. Shu yerga workspace ID'ingizni yozing (yoki Railway'da
# ANTHROPIC_WORKSPACE_ID muhit o'zgaruvchisi orqali bering).
ANTHROPIC_WORKSPACE_ID = os.environ.get("ANTHROPIC_WORKSPACE_ID", "wrkspc_01EE58rCLYsbcgK7mVUoRW38")

# Ilova bilan backend o'rtasidagi maxfiy kalit (o'zingiz o'ylab toping)
APP_SECRET = os.environ.get("ULTRON_SECRET", "ultron-maxfiy-kalit-almashtiring")

# Telegram bot (ixtiyoriy). Bo'sh qoldirsangiz, Telegram ishlamaydi.
# Bot yaratish: Telegram'da @BotFather ga yozing -> /newbot
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
# Faqat shu chat_id'dan kelgan xabarlarga javob beriladi (o'zingizning ID'ingiz).
# ID'ingizni bilish uchun Telegram'da @userinfobot ga yozing.
TELEGRAM_ALLOWED_CHAT_ID = os.environ.get("TELEGRAM_ALLOWED_CHAT_ID", "")

DB_PATH = os.environ.get("ULTRON_DB", "ultron.db")
HOST = "0.0.0.0"
# Railway PORT muhit o'zgaruvchisini avtomatik beradi; mahalliyda ULTRON_PORT
# yoki standart 8000 ishlatiladi.
PORT = int(os.environ.get("PORT", os.environ.get("ULTRON_PORT", "8000")))

# Railway PostgreSQL qo'shsangiz, DATABASE_URL avtomatik beriladi.
# Bo'lmasa, mahalliy SQLite fayliga yoziladi (sinov uchun qulay).
DATABASE_URL = os.environ.get("DATABASE_URL", "")
USE_POSTGRES = bool(DATABASE_URL)

if USE_POSTGRES:
    import psycopg2  # pip install psycopg2-binary
    PARAM = "%s"
else:
    import sqlite3
    PARAM = "?"

# ------------------------------------------------------------------
# 2) MA'LUMOTLAR BAZASI (xotira) — PostgreSQL yoki SQLite
# ------------------------------------------------------------------
#
# Har ikkala holatda ham qatorlar oddiy tuple (r[0], r[1], ...) sifatida
# qaytariladi, shuning uchun quyidagi funksiyalar ikkala baza uchun ham
# bir xil ishlaydi.

_db_lock = threading.Lock()


def get_conn():
    if USE_POSTGRES:
        return psycopg2.connect(DATABASE_URL, sslmode="require")
    return sqlite3.connect(DB_PATH, check_same_thread=False)


def init_db():
    with _db_lock:
        conn = get_conn()
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute(
                """CREATE TABLE IF NOT EXISTS messages(
                    id SERIAL PRIMARY KEY,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    ts TEXT NOT NULL
                )"""
            )
            cur.execute(
                """CREATE TABLE IF NOT EXISTS reminders(
                    id SERIAL PRIMARY KEY,
                    text TEXT NOT NULL,
                    due_time TEXT NOT NULL,
                    done INTEGER DEFAULT 0,
                    notified INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL
                )"""
            )
        else:
            cur.execute(
                """CREATE TABLE IF NOT EXISTS messages(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    ts TEXT NOT NULL
                )"""
            )
            cur.execute(
                """CREATE TABLE IF NOT EXISTS reminders(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text TEXT NOT NULL,
                    due_time TEXT NOT NULL,
                    done INTEGER DEFAULT 0,
                    notified INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL
                )"""
            )
        conn.commit()
        cur.close()
        conn.close()
    print(f"Baza tayyor: {'PostgreSQL (Railway)' if USE_POSTGRES else 'SQLite (mahalliy)'}")


def save_message(role: str, content: str, channel: str):
    with _db_lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            f"INSERT INTO messages(role, content, channel, ts) VALUES ({PARAM}, {PARAM}, {PARAM}, {PARAM})",
            (role, content, channel, datetime.datetime.now().isoformat()),
        )
        conn.commit()
        cur.close()
        conn.close()


def get_recent_history(limit: int = 16) -> List[dict]:
    """Oxirgi N ta xabarni Claude API formatiga moslab qaytaradi."""
    with _db_lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            f"SELECT role, content FROM messages ORDER BY id DESC LIMIT {PARAM}", (limit,)
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
    rows = list(reversed(rows))
    return [{"role": r[0], "content": r[1]} for r in rows]


# ------------------------------------------------------------------
# 3) ESLATMALAR (tool orqali boshqariladi)
# ------------------------------------------------------------------

def tool_add_reminder(text: str, due_time: str) -> str:
    with _db_lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            f"INSERT INTO reminders(text, due_time, created_at) VALUES ({PARAM}, {PARAM}, {PARAM})",
            (text, due_time, datetime.datetime.now().isoformat()),
        )
        conn.commit()
        cur.close()
        conn.close()
    return f"Eslatma qo'shildi: '{text}' -> {due_time}"


def tool_list_reminders() -> str:
    with _db_lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT id, text, due_time FROM reminders WHERE done = 0 ORDER BY due_time"
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
    if not rows:
        return "Hozircha faol eslatma yo'q."
    return json.dumps(
        [{"id": r[0], "text": r[1], "due_time": r[2]} for r in rows],
        ensure_ascii=False,
    )


def tool_delete_reminder(reminder_id: int) -> str:
    with _db_lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(f"DELETE FROM reminders WHERE id = {PARAM}", (reminder_id,))
        deleted = cur.rowcount
        conn.commit()
        cur.close()
        conn.close()
    if deleted == 0:
        return f"ID={reminder_id} bo'lgan eslatma topilmadi."
    return f"ID={reminder_id} bo'lgan eslatma o'chirildi."


TOOLS_SCHEMA = [
    {
        "name": "add_reminder",
        "description": "Foydalanuvchi uchun aniq sana-vaqtli eslatma qo'shadi.",
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Eslatma matni"},
                "due_time": {
                    "type": "string",
                    "description": "Aniq sana-vaqt, ISO 8601 formatida, masalan 2026-08-31T09:00:00. Nisbiy vaqtlarni ('ertaga', 'bir soatdan keyin') hozirgi vaqtga qarab aniq sanaga o'zingiz aylantiring.",
                },
            },
            "required": ["text", "due_time"],
        },
    },
    {
        "name": "list_reminders",
        "description": "Foydalanuvchining barcha faol (hali bajarilmagan) eslatmalari ro'yxatini qaytaradi.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "delete_reminder",
        "description": "ID raqami bo'yicha eslatmani o'chiradi.",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "integer", "description": "Eslatma ID raqami"}},
            "required": ["id"],
        },
    },
]


def run_tool(name: str, tool_input: dict) -> str:
    if name == "add_reminder":
        return tool_add_reminder(tool_input.get("text", ""), tool_input.get("due_time", ""))
    if name == "list_reminders":
        return tool_list_reminders()
    if name == "delete_reminder":
        return tool_delete_reminder(int(tool_input.get("id", -1)))
    return f"Noma'lum tool: {name}"


# ------------------------------------------------------------------
# 4) CLAUDE API BILAN GAPLASHISH
# ------------------------------------------------------------------

CLAUDE_API_URL = "https://api.anthropic.com/v1/messages"


def build_system_prompt() -> str:
    now = datetime.datetime.now().isoformat(timespec="seconds")
    return (
        "Sen Ultron ismli, foydalanuvchiga shaxsan xizmat qiladigan sun'iy intellekt "
        "yordamchisisan. Har doim o'zbek tilida, tabiiy, samimiy va qisqa-lo'nda javob ber. "
        f"Hozirgi aniq sana va vaqt: {now}. "
        "Agar foydalanuvchi eslatma qo'shish, ko'rish yoki o'chirishni so'rasa, mos tool'dan "
        "foydalan. Nisbiy vaqtlarni ('ertaga', 'yarim soatdan keyin') hozirgi vaqtga qarab "
        "aniq ISO sanaga aylantirib ber."
    )


def call_claude(messages: List[dict]) -> str:
    if not ANTHROPIC_API_KEY or "BU_YERGA" in ANTHROPIC_API_KEY:
        return (
            "Claude API kaliti sozlanmagan. ultron_backend.py faylidagi "
            "ANTHROPIC_API_KEY qiymatini to'ldiring."
        )

    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    if ANTHROPIC_WORKSPACE_ID:
        headers["anthropic-workspace-id"] = ANTHROPIC_WORKSPACE_ID

    conversation = list(messages)

    for _ in range(5):  # tool-chaqiruv aylanalari uchun limit
        payload = {
            "model": CLAUDE_MODEL,
            "max_tokens": 1024,
            "system": build_system_prompt(),
            "messages": conversation,
            "tools": TOOLS_SCHEMA,
        }
        resp = requests.post(CLAUDE_API_URL, headers=headers, json=payload, timeout=60)
        if resp.status_code != 200:
            return f"Claude API xatosi ({resp.status_code}): {resp.text[:300]}"

        data = resp.json()
        content_blocks = data.get("content", [])
        stop_reason = data.get("stop_reason")

        # Assistant javobini conversation'ga qo'shamiz (tool_use bo'lsa ham)
        conversation.append({"role": "assistant", "content": content_blocks})

        if stop_reason == "tool_use":
            tool_results = []
            for block in content_blocks:
                if block.get("type") == "tool_use":
                    result_text = run_tool(block["name"], block.get("input", {}))
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block["id"],
                            "content": result_text,
                        }
                    )
            conversation.append({"role": "user", "content": tool_results})
            continue  # Claude'ga natijani qaytarib, yakuniy javobni so'raymiz

        # Oddiy matnli yakuniy javob
        text_parts = [b["text"] for b in content_blocks if b.get("type") == "text"]
        return "\n".join(text_parts).strip() or "(bo'sh javob)"

    return "Kechirasiz, so'rovni bajarishda muammo yuzaga keldi (tool aylana limiti)."


def process_user_message(user_text: str, channel: str) -> str:
    save_message("user", user_text, channel)
    history = get_recent_history(limit=16)
    reply = call_claude(history)
    save_message("assistant", reply, channel)
    return reply


# ------------------------------------------------------------------
# 5) FON JARAYONI — eslatmalarni tekshirish
# ------------------------------------------------------------------

pending_notifications: List[dict] = []
_pending_lock = threading.Lock()


def send_telegram_message(text: str):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_ALLOWED_CHAT_ID:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_ALLOWED_CHAT_ID, "text": text},
            timeout=15,
        )
    except Exception as e:
        print("Telegram yuborishda xato:", e)


def reminder_checker_loop():
    while True:
        try:
            now_iso = datetime.datetime.now().isoformat()
            with _db_lock:
                conn = get_conn()
                cur = conn.cursor()
                cur.execute(
                    f"SELECT id, text, due_time FROM reminders "
                    f"WHERE done = 0 AND notified = 0 AND due_time <= {PARAM}",
                    (now_iso,),
                )
                rows = cur.fetchall()
                for r in rows:
                    cur.execute(
                        f"UPDATE reminders SET notified = 1, done = 1 WHERE id = {PARAM}", (r[0],)
                    )
                conn.commit()
                cur.close()
                conn.close()

            for r in rows:
                msg = f"⏰ Eslatma: {r[1]}"
                send_telegram_message(msg)
                with _pending_lock:
                    pending_notifications.append({"id": r[0], "text": r[1]})
        except Exception as e:
            print("reminder_checker_loop xato:", e)
        time.sleep(15)


# ------------------------------------------------------------------
# 6) TELEGRAM BOT (long polling)
# ------------------------------------------------------------------

def telegram_loop():
    if not TELEGRAM_BOT_TOKEN:
        print("Telegram bot sozlanmagan (TELEGRAM_BOT_TOKEN bo'sh) — o'tkazib yuborildi.")
        return

    print("Telegram bot ishga tushdi.")
    offset = None
    while True:
        try:
            params = {"timeout": 30}
            if offset is not None:
                params["offset"] = offset
            resp = requests.get(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates",
                params=params,
                timeout=40,
            )
            data = resp.json()
            for update in data.get("result", []):
                offset = update["update_id"] + 1
                msg = update.get("message", {})
                chat_id = str(msg.get("chat", {}).get("id", ""))
                text = msg.get("text", "")
                if not text:
                    continue
                if TELEGRAM_ALLOWED_CHAT_ID and chat_id != str(TELEGRAM_ALLOWED_CHAT_ID):
                    continue  # faqat egasi buyruq bera oladi
                reply = process_user_message(text, channel="telegram")
                send_telegram_message(reply)
        except Exception as e:
            print("telegram_loop xato:", e)
            time.sleep(5)


# ------------------------------------------------------------------
# 7) HTTP API (Flutter ilova shu bilan gaplashadi)
# ------------------------------------------------------------------

app = FastAPI(title="Ultron Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str


def check_secret(x_ultron_secret: Optional[str]):
    if x_ultron_secret != APP_SECRET:
        raise HTTPException(status_code=401, detail="Noto'g'ri maxfiy kalit")


@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.datetime.now().isoformat()}


@app.post("/chat")
def chat(req: ChatRequest, x_ultron_secret: Optional[str] = Header(None)):
    check_secret(x_ultron_secret)
    reply = process_user_message(req.message, channel="app")
    return {"reply": reply}


@app.get("/reminders")
def list_reminders_endpoint(x_ultron_secret: Optional[str] = Header(None)):
    check_secret(x_ultron_secret)
    return json.loads(tool_list_reminders()) if tool_list_reminders() != "Hozircha faol eslatma yo'q." else []


@app.get("/pending_notifications")
def get_pending_notifications(x_ultron_secret: Optional[str] = Header(None)):
    check_secret(x_ultron_secret)
    with _pending_lock:
        items = pending_notifications.copy()
        pending_notifications.clear()
    return {"notifications": items}


# ------------------------------------------------------------------
# 8) ISHGA TUSHIRISH
# ------------------------------------------------------------------

if __name__ == "__main__":
    init_db()
    threading.Thread(target=reminder_checker_loop, daemon=True).start()
    threading.Thread(target=telegram_loop, daemon=True).start()
    print(f"Ultron backend ishga tushdi: http://{HOST}:{PORT}")
    print(f"Maxfiy kalit (ilovaga kerak bo'ladi): {APP_SECRET}")
    uvicorn.run(app, host=HOST, port=PORT)
