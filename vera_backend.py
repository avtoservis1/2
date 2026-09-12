"""
==================================================================
 VERA — Shaxsiy AI yordamchi backend (1-bosqich + 2-bosqich MVP)
==================================================================

Bu fayl quyidagilarni bajaradi:
  - Claude API bilan gaplashish (miya)
  - Suhbat tarixini bazada saqlash (xotira) — PostgreSQL (Railway) yoki
    mahalliy SQLite (agar DATABASE_URL berilmagan bo'lsa)
  - Eslatma qo'shish / ko'rish / o'chirish (Claude "tool" sifatida chaqiradi)
  - Telegram bot orqali ham gaplashish imkoni (bir xil miya/xotira)
  - Fon rejimida eslatmalarni tekshirib, vaqti kelganda bildirish
  - Telefon/kompyuter (Flutter) ilova ulanadigan HTTP API
  - OVOZ (TTS): /speak endpoint orqali matnni OpenAI'ning nutq sintezi
    (gpt-4o-mini-tts) orqali MP3'ga aylantirib qaytaradi (OPENAI_API_KEY
    talab qilinadi)
  - OVOZ (STT): /transcribe endpoint orqali ilova yozib olgan audio
    (foydalanuvchi gapi) OpenAI'ning nutqni matnga aylantirish modeliga
    (gpt-4o-mini-transcribe) yuboriladi va tanilgan matn qaytariladi
    (xuddi shu OPENAI_API_KEY ishlatiladi, qo'shimcha kalit kerak emas)
  - INTERNETDAN QIDIRISH / OB-HAVO / VALYUTA: Claude'ning o'zining
    web_search vositasi orqali (qo'shimcha API kalit kerak emas)
  - GITHUB: kod review, commit/push va Pull Request bilan ishlash
    (GITHUB_TOKEN va GITHUB_REPO talab qilinadi)

MAHALLIY ISHGA TUSHIRISH (sinov uchun):
  1) Python 3.10+ kerak
  2) Terminalda:
       pip install fastapi uvicorn requests psycopg2-binary
  3) Quyidagi CONFIG bo'limiga o'z ma'lumotlaringizni yozing
     (yoki muhit o'zgaruvchisi orqali bering)
  4) Ishga tushirish:
       python vera_backend.py
     Server manzili:  http://<kompyuter-ip>:8000

RAILWAY'GA JOYLASH:
  1) Loyihani GitHub'ga yuklang (shu vera_backend.py va alohida berilgan
     requirements.txt fayli bilan birga)
  2) Railway'da "New Project" -> "Deploy from GitHub repo"
  3) Railway'da "New" -> "Database" -> "PostgreSQL" qo'shing.
     Railway avtomatik ravishda DATABASE_URL muhit o'zgaruvchisini
     backend xizmatingizga ulaydi (Variables bo'limida ko'rasiz/
     "Reference" qilasiz).
  4) Railway "Variables" bo'limida quyidagilarni qo'shing:
       ANTHROPIC_API_KEY = sizning Claude API kalitingiz
       OPENAI_API_KEY = sizning OpenAI API kalitingiz (ovoz uchun)
       TELEGRAM_BOT_TOKEN (ixtiyoriy)
       TELEGRAM_ALLOWED_CHAT_ID (ixtiyoriy)
       VERA_VOICE (ixtiyoriy, standart: nova)
       OPENAI_STT_MODEL (ixtiyoriy, standart: gpt-4o-mini-transcribe)
       GITHUB_TOKEN (ixtiyoriy, GitHub integratsiyasi uchun)
       GITHUB_REPO (ixtiyoriy, masalan "foydalanuvchi/repo-nomi")
     PORT va DATABASE_URL'ni Railway o'zi avtomatik beradi — qo'lda
     kiritmang.
  5) "Start Command" sifatida quyidagini bering:
       python vera_backend.py
  6) Deploy tugagach, Railway sizga ochiq URL beradi (masalan
     https://vera-production.up.railway.app) — shuni Flutter ilova
     sozlamalariga "Backend manzili" sifatida kiritasiz.

XAVFSIZLIK:
  DIQQAT: bu versiyada maxfiy kalit tekshiruvi butunlay o'chirilgan —
  backend manzilini bilgan har qanday odam (yoki bot) so'rov yubora oladi,
  Claude API balansingizni sarflashi va xabarlaringizni o'qishi mumkin.
  Bu shaxsiy sinov uchun qulay, lekin manzilni hech kimga tarqatmang.
  Keyinroq xohlasangiz, maxfiy kalitni qaytadan qo'shish mumkin.
"""

import os
import re
import io
import json
import asyncio
import threading
import time
import datetime
from typing import List

import base64

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
import uvicorn

# pip install pydub — audio ustida ishlov berish (gaplar orasidagi uzun
# pauzalarni qisqartirish) uchun. Bundan tashqari serverda "ffmpeg" dasturi
# o'rnatilgan bo'lishi kerak (Railway uchun nixpacks.toml orqali).
from pydub import AudioSegment
from pydub.silence import detect_silence

# ------------------------------------------------------------------
# 1) CONFIG — shu yerga o'zingizning ma'lumotlaringizni yozing
# ------------------------------------------------------------------

# Claude API kalitingiz (https://console.anthropic.com dan olingan)
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "BU_YERGA_CLAUDE_API_KEYINGIZNI_YOZING")

# Ishlatiladigan model
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5")

# Telegram bot (ixtiyoriy). Bo'sh qoldirsangiz, Telegram ishlamaydi.
# Bot yaratish: Telegram'da @BotFather ga yozing -> /newbot
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
# Faqat shu chat_id'dan kelgan xabarlarga javob beriladi (o'zingizning ID'ingiz).
# ID'ingizni bilish uchun Telegram'da @userinfobot ga yozing.
TELEGRAM_ALLOWED_CHAT_ID = os.environ.get("TELEGRAM_ALLOWED_CHAT_ID", "")

# OVOZ (TTS) — endi OpenAI'ning nutq sintezi orqali ishlaydi (edge-tts
# o'rniga). O'zbekcha uchun alohida "ovoz nomi" yo'q — OpenAI TTS modeli
# matn tilini o'zi aniqlab, shu tilda tabiiy talaffuz qiladi. VERA_VOICE
# orqali OpenAI ovozlaridan birini tanlaysiz: alloy, echo, fable, onyx,
# nova, shimmer, coral, ash, sage — ayol ovoziga eng yaqinlari: "nova",
# "shimmer", "coral".
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "BU_YERGA_OPENAI_API_KEYINGIZNI_YOZING")
OPENAI_TTS_MODEL = os.environ.get("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
VERA_VOICE = os.environ.get("VERA_VOICE", "nova")
# Ovozga "qanday ohangda gapirish kerak" haqida qisqa yo'riqnoma (faqat
# gpt-4o-mini-tts modeli qo'llab-quvvatlaydi; eski tts-1 modellarida
# e'tiborga olinmaydi, xato bermaydi).
VERA_VOICE_STYLE = os.environ.get(
    "VERA_VOICE_STYLE",
    "Iliq, samimiy va tabiiy ohangda, o'zbek tilida, shoshilmasdan gapir.",
)

# GITHUB INTEGRATSIYASI — kod review, commit/push va Pull Request bilan
# ishlash uchun. Token yaratish: github.com -> Settings -> Developer
# settings -> Personal access tokens -> Fine-grained token (repo'ga
# yozish huquqi bilan). GITHUB_REPO formati: "foydalanuvchi/repo-nomi".
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "")
GITHUB_DEFAULT_BASE_BRANCH = os.environ.get("GITHUB_DEFAULT_BASE_BRANCH", "main")
GITHUB_API_URL = "https://api.github.com"

# Windows kompyuteringizda ishlaydigan "agent" (windows_agent.py) shu tokenni
# bilishi kerak — aks holda buyruqlarni olib bajara olmaydi. O'zingiz uzun,
# tasodifiy qator o'ylab toping va ikkala tomonga (server + agent) bir xil
# qiymatni bering.
AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "O'ZGARTIRING_MAXFIY_TOKEN")
# Bitta vaqtda nechta kompyuter ulanishi mumkinligini nazorat qilish uchun
# har bir agent o'zini nom bilan tanishtiradi (masalan "ish-kompyuteri").
DEFAULT_AGENT_NAME = os.environ.get("DEFAULT_AGENT_NAME", "windows-pc")
# Claude tool orqali buyruq yuborgach, Windows agentdan javob kelishini
# necha soniya kutishi (agent odatda 1-3 soniyada so'raydi va bajaradi).
PC_COMMAND_TIMEOUT_SEC = int(os.environ.get("PC_COMMAND_TIMEOUT_SEC", "25"))
# Windows agent /agent/next_command so'raganda, buyruq hali yo'q bo'lsa,
# server shuncha soniyagacha "kutib turadi" (long-polling) — shu bilan
# agent'ning navbatdagi so'rovini kutish shart bo'lmaydi. MUHIM: bu qiymat
# windows_agent.py'dagi so'rov timeout'idan (25s) kamroq bo'lishi shart,
# aks holda agent tomonida vaqtidan oldin "timeout" xatosi chiqadi.
AGENT_LONG_POLL_SEC = float(os.environ.get("AGENT_LONG_POLL_SEC", "18"))

DB_PATH = os.environ.get("VERA_DB", "vera.db")
HOST = "0.0.0.0"
# Railway PORT muhit o'zgaruvchisini avtomatik beradi; mahalliyda VERA_PORT
# yoki standart 8000 ishlatiladi.
PORT = int(os.environ.get("PORT", os.environ.get("VERA_PORT", "8080")))

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
            cur.execute(
                """CREATE TABLE IF NOT EXISTS notifications(
                    id SERIAL PRIMARY KEY,
                    type TEXT NOT NULL,
                    text TEXT NOT NULL,
                    is_read INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL
                )"""
            )
            cur.execute(
                """CREATE TABLE IF NOT EXISTS pc_commands(
                    id SERIAL PRIMARY KEY,
                    agent_name TEXT NOT NULL,
                    action TEXT NOT NULL,
                    params TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    result TEXT,
                    created_at TEXT NOT NULL,
                    completed_at TEXT
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
            cur.execute(
                """CREATE TABLE IF NOT EXISTS notifications(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    type TEXT NOT NULL,
                    text TEXT NOT NULL,
                    is_read INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL
                )"""
            )
            cur.execute(
                """CREATE TABLE IF NOT EXISTS pc_commands(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent_name TEXT NOT NULL,
                    action TEXT NOT NULL,
                    params TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    result TEXT,
                    created_at TEXT NOT NULL,
                    completed_at TEXT
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


def get_chat_history_for_display(limit: int = 200, channel: str = "app") -> List[dict]:
    """Chat ekranida ko'rsatish uchun to'liq tarixni qaytaradi (rol, matn,
    vaqt). Faqat 'app' kanalidagi xabarlar olinadi (ilova va ovozli suhbat
    ham shu kanalga yozadi) — Telegram xabarlari aralashib ketmasligi
    uchun. Barcha qurilmalar bitta backendga ulangani sababli, bu yerda
    qaytadigan tarix barcha qurilmalarda bir xil bo'ladi."""
    with _db_lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            f"SELECT role, content, ts FROM messages WHERE channel = {PARAM} "
            f"ORDER BY id DESC LIMIT {PARAM}",
            (channel, limit),
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
    rows = list(reversed(rows))
    return [{"role": r[0], "content": r[1], "ts": r[2]} for r in rows]


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


# ------------------------------------------------------------------
# 3.5) WINDOWS KOMPYUTERNI BOSHQARISH (buyruqlar navbati orqali)
# ------------------------------------------------------------------
#
# Backend Windows kompyuterga to'g'ridan-to'g'ri ulanmaydi (kompyuter NAT
# orqasida bo'lishi mumkin). Buning o'rniga: backend buyruqni "navbat"ga
# (pc_commands jadvali) yozadi, kompyuterda doim ishlab turgan alohida
# dastur (windows_agent.py) har 1-2 soniyada shu navbatni so'rab turadi,
# topgan buyruqni bajaradi va natijasini qaytarib yuboradi. Claude tool
# chaqirganda shu jarayon tugashini (yoki timeout bo'lishini) kutadi.

def enqueue_pc_command(action: str, params: dict, agent_name: str = None) -> int:
    agent_name = agent_name or DEFAULT_AGENT_NAME
    with _db_lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            f"INSERT INTO pc_commands(agent_name, action, params, created_at) "
            f"VALUES ({PARAM}, {PARAM}, {PARAM}, {PARAM})"
            + (" RETURNING id" if USE_POSTGRES else ""),
            (agent_name, action, json.dumps(params, ensure_ascii=False),
             datetime.datetime.now().isoformat()),
        )
        if USE_POSTGRES:
            new_id = cur.fetchone()[0]
        else:
            new_id = cur.lastrowid
        conn.commit()
        cur.close()
        conn.close()
    return new_id


def get_pc_command_status(command_id: int):
    with _db_lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            f"SELECT status, result FROM pc_commands WHERE id = {PARAM}", (command_id,)
        )
        row = cur.fetchone()
        cur.close()
        conn.close()
    return row  # (status, result) yoki None


def run_pc_command_and_wait(action: str, params: dict, agent_name: str = None) -> str:
    """Buyruqni navbatga qo'yadi va Windows agent bajarib, natija qaytargunicha
    (yoki PC_COMMAND_TIMEOUT_SEC soniya o'tguncha) kutadi. Claude tool sifatida
    chaqirganda ishlatiladi, shuning uchun natija darhol suhbatga qaytadi."""
    command_id = enqueue_pc_command(action, params, agent_name)
    deadline = time.time() + PC_COMMAND_TIMEOUT_SEC
    while time.time() < deadline:
        row = get_pc_command_status(command_id)
        if row and row[0] in ("done", "error"):
            status, result = row
            prefix = "Bajarildi" if status == "done" else "Xatolik"
            return f"{prefix}: {result or '(natija yoq)'}"
        time.sleep(0.2)
    return (
        "Kompyuter javob bermadi (timeout). Windows agent dasturi (windows_agent.py) "
        "kompyuteringizda ishlab turganini va internetga ulanganini tekshiring."
    )


def tool_pc_open_app(app_name: str) -> str:
    return run_pc_command_and_wait("open_app", {"app_name": app_name})


def tool_pc_close_app(app_name: str) -> str:
    return run_pc_command_and_wait("close_app", {"app_name": app_name})


def tool_pc_run_command(command: str) -> str:
    return run_pc_command_and_wait("run_shell_command", {"command": command})


def tool_pc_open_url(url: str) -> str:
    return run_pc_command_and_wait("open_url", {"url": url})


def tool_pc_power(action: str) -> str:
    return run_pc_command_and_wait("system_power", {"action": action})


def tool_pc_status() -> str:
    return run_pc_command_and_wait("get_system_status", {})


def tool_pc_list_dir(path: str = "") -> str:
    return run_pc_command_and_wait("list_dir", {"path": path})


def tool_pc_screen_size() -> str:
    return run_pc_command_and_wait("get_screen_size", {})


def tool_pc_mouse_move(x: int, y: int, duration: float = 0.2) -> str:
    return run_pc_command_and_wait("mouse_move", {"x": x, "y": y, "duration": duration})


def tool_pc_mouse_click(
    x: int = None, y: int = None, button: str = "left", clicks: int = 1, double: bool = False
) -> str:
    params = {"button": button, "clicks": clicks, "double": double}
    if x is not None and y is not None:
        params["x"] = x
        params["y"] = y
    return run_pc_command_and_wait("mouse_click", params)


def tool_pc_mouse_scroll(amount: int, x: int = None, y: int = None) -> str:
    params = {"amount": amount}
    if x is not None and y is not None:
        params["x"] = x
        params["y"] = y
    return run_pc_command_and_wait("mouse_scroll", params)


def tool_pc_mouse_drag(from_x: int, from_y: int, to_x: int, to_y: int, button: str = "left") -> str:
    return run_pc_command_and_wait(
        "mouse_drag",
        {"from_x": from_x, "from_y": from_y, "to_x": to_x, "to_y": to_y, "button": button},
    )


def tool_pc_key_press(keys: str) -> str:
    return run_pc_command_and_wait("key_press", {"keys": keys})


def tool_pc_type_text(text: str) -> str:
    return run_pc_command_and_wait("type_text", {"text": text})


# ------------------------------------------------------------------
# 3.6) GITHUB / CLAUDE CODE INTEGRATSIYASI
# ------------------------------------------------------------------
#
# Bu bo'lim ikki xil ishni ajratadi:
#  - "git_commit_and_push" — mahalliy fayllarni commit qilish/push qilish
#    Windows kompyuterdagi repo papkasida amalga oshadi, shuning uchun u
#    mavjud pc_run_command mexanizmi (windows_agent.py) orqali ishlaydi.
#  - "github_*" — GitHub'ning o'zidagi Pull Request va kod-review
#    amallari, bular to'g'ridan-to'g'ri GitHub REST API'siga (GITHUB_TOKEN
#    bilan) backend orqali murojaat qiladi, Windows kompyuter shart emas.

def _check_github_config():
    if not GITHUB_TOKEN or not GITHUB_REPO:
        raise RuntimeError(
            "GitHub sozlanmagan. Serverda GITHUB_TOKEN va GITHUB_REPO "
            "muhit o'zgaruvchilarini o'rnating (masalan GITHUB_REPO="
            "\"foydalanuvchi/repo-nomi\")."
        )


def _github_headers():
    return {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def tool_git_commit_and_push(commit_message: str, repo_path: str = "", branch: str = "") -> str:
    """Windows kompyuterdagi repo papkasida `git add/commit/push` bajaradi.
    repo_path berilmasa, agent hozirgi ishlab turgan papkasini ishlatadi
    (odatda repo shu yerga clone qilingan bo'lishi kerak)."""
    if not commit_message.strip():
        return "Commit xabari bo'sh bo'lishi mumkin emas."
    cd_part = f'cd /d "{repo_path}" && ' if repo_path.strip() else ""
    branch_part = f" {branch.strip()}" if branch.strip() else ""
    safe_message = commit_message.replace('"', "'")
    command = (
        f'{cd_part}git add -A && git commit -m "{safe_message}" '
        f'&& git push origin{branch_part}'
    )
    return tool_pc_run_command(command)


def tool_github_create_pr(title: str, head_branch: str, body: str = "", base_branch: str = "") -> str:
    _check_github_config()
    base_branch = base_branch.strip() or GITHUB_DEFAULT_BASE_BRANCH
    resp = requests.post(
        f"{GITHUB_API_URL}/repos/{GITHUB_REPO}/pulls",
        headers=_github_headers(),
        json={"title": title, "head": head_branch, "base": base_branch, "body": body},
        timeout=30,
    )
    if resp.status_code not in (200, 201):
        return f"PR yaratishda xato ({resp.status_code}): {resp.text[:300]}"
    data = resp.json()
    return f"PR #{data.get('number')} yaratildi: {data.get('html_url')}"


def tool_github_list_open_prs() -> str:
    _check_github_config()
    resp = requests.get(
        f"{GITHUB_API_URL}/repos/{GITHUB_REPO}/pulls",
        headers=_github_headers(),
        params={"state": "open", "per_page": 20},
        timeout=30,
    )
    if resp.status_code != 200:
        return f"PR ro'yxatini olishda xato ({resp.status_code}): {resp.text[:300]}"
    prs = resp.json()
    if not prs:
        return "Hozircha ochiq Pull Request yo'q."
    return json.dumps(
        [
            {
                "number": pr["number"],
                "title": pr["title"],
                "author": pr["user"]["login"],
                "url": pr["html_url"],
                "branch": pr["head"]["ref"],
            }
            for pr in prs
        ],
        ensure_ascii=False,
    )


def tool_github_review_pr(pr_number: int) -> str:
    """PR'ning diff (o'zgarishlar) matnini GitHub'dan olib, Claude'ga
    tool_result sifatida qaytaradi — shundan keyin Claude shu diff'ni
    o'qib, kod review sifatida fikr-mulohaza yozadi (xato, xavfsizlik,
    uslub bo'yicha)."""
    _check_github_config()
    resp = requests.get(
        f"{GITHUB_API_URL}/repos/{GITHUB_REPO}/pulls/{pr_number}",
        headers={**_github_headers(), "Accept": "application/vnd.github.v3.diff"},
        timeout=30,
    )
    if resp.status_code != 200:
        return f"PR diff'ni olishda xato ({resp.status_code}): {resp.text[:300]}"
    diff_text = resp.text[:12000]  # juda katta diff'larni kesib qo'yamiz
    return f"PR #{pr_number} diff (review uchun):\n{diff_text}"


def tool_github_post_pr_comment(pr_number: int, comment: str) -> str:
    _check_github_config()
    resp = requests.post(
        f"{GITHUB_API_URL}/repos/{GITHUB_REPO}/issues/{pr_number}/comments",
        headers=_github_headers(),
        json={"body": comment},
        timeout=30,
    )
    if resp.status_code not in (200, 201):
        return f"Izoh qoldirishda xato ({resp.status_code}): {resp.text[:300]}"
    return f"PR #{pr_number} ga izoh qoldirildi."


TOOLS_SCHEMA = [
    # OpenAI/Anthropic hosted vosita: Claude'ning o'zi internetdan qidiradi.
    # Shu bitta vosita orqali "internetdan qidirish", "ob-havo", "valyuta
    # kursi", "narx solishtirish" kabi barcha savollar javob topadi — bular
    # uchun alohida weather/currency API kaliti kerak emas.
    {"type": "web_search_20250305", "name": "web_search"},
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
    {
        "name": "notify_progress",
        "description": (
            "Foydalanuvchiga ilova bildirishnomalar markazi va Telegram orqali "
            "qisqa xabar yuboradi — masalan uzoq davom etadigan vazifa "
            "(loyiha, kod yozish, build) boshlanganda, oraliq holatida yoki "
            "tugaganda foydalaning. Oddiy suhbat javoblari uchun ishlatmang, "
            "faqat foydalanuvchi ilova ochiq bo'lmasa ham bilishi kerak bo'lgan "
            "muhim holat yangilanishlari uchun."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "Qisqa, aniq xabar matni, masalan: 'Loyiha tayyor bo'ldi' yoki 'Backend deploy qilinmoqda, 5 daqiqa kutish kerak'.",
                }
            },
            "required": ["text"],
        },
    },
    {
        "name": "pc_open_app",
        "description": (
            "Windows kompyuterda dastur/ilova ochadi (masalan Chrome, VS Code, "
            "Word, Spotify, Explorer). Faqat kompyuterni boshqarish so'ralganda ishlating."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "app_name": {
                    "type": "string",
                    "description": "Ochish kerak bo'lgan dastur nomi, masalan 'chrome', 'notepad', 'code', 'spotify'.",
                }
            },
            "required": ["app_name"],
        },
    },
    {
        "name": "pc_close_app",
        "description": "Windows kompyuterda ishlab turgan dasturni majburan yopadi (jarayon nomi bo'yicha).",
        "input_schema": {
            "type": "object",
            "properties": {
                "app_name": {
                    "type": "string",
                    "description": "Yopish kerak bo'lgan dastur/jarayon nomi, masalan 'chrome', 'notepad.exe'.",
                }
            },
            "required": ["app_name"],
        },
    },
    {
        "name": "pc_run_command",
        "description": (
            "Windows kompyuterda terminal (cmd/PowerShell) buyrug'ini ishga tushiradi va "
            "natijasini qaytaradi. Fayl bilan ishlash, papka ochish, dastur o'rnatish, "
            "build/deploy kabi murakkab amallar uchun ishlating. Xavfli buyruqlarga "
            "(diskni formatlash, muhim fayllarni o'chirish) ehtiyot bo'ling."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "To'liq terminal buyrug'i, masalan 'dir C:\\Users' yoki 'git status'.",
                }
            },
            "required": ["command"],
        },
    },
    {
        "name": "pc_open_url",
        "description": "Windows kompyuterda standart brauzerda berilgan saytni ochadi.",
        "input_schema": {
            "type": "object",
            "properties": {"url": {"type": "string", "description": "To'liq URL manzil."}},
            "required": ["url"],
        },
    },
    {
        "name": "pc_power",
        "description": "Windows kompyuterni boshqaradi: qulflash, uyquga yuborish, qayta yuklash yoki o'chirish.",
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["lock", "sleep", "restart", "shutdown"],
                    "description": "Bajariladigan amal.",
                }
            },
            "required": ["action"],
        },
    },
    {
        "name": "pc_status",
        "description": "Windows kompyuterning joriy holatini qaytaradi: protsessor/xotira yuklamasi, batareya, ishlayotgan asosiy dasturlar.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "pc_list_dir",
        "description": (
            "Windows kompyuterdagi berilgan papkadagi fayl va papkalar ro'yxatini "
            "qaytaradi (nomi, turi, hajmi). Foydalanuvchi 'kompyuterimdagi fayllarni "
            "ko'rsat', 'Downloads papkasida nima bor' kabi so'ragan hollarda ishlating."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "To'liq papka manzili, masalan 'C:\\\\Users\\\\User\\\\Downloads'. Bo'sh qoldirilsa, foydalanuvchi profil papkasi ko'rsatiladi.",
                }
            },
        },
    },
    {
        "name": "pc_screen_size",
        "description": "Windows kompyuterning ekran o'lchamini (kenglik x balandlik) va sichqoncha joriy pozitsiyasini qaytaradi. Sichqoncha bilan ishlashdan oldin ekran chegaralarini bilish uchun ishlating.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "pc_mouse_move",
        "description": "Windows kompyuterda sichqonchani berilgan ekran koordinatasiga (piksel, chap-yuqori burchakdan hisoblanadi) ko'chiradi.",
        "input_schema": {
            "type": "object",
            "properties": {
                "x": {"type": "integer", "description": "X koordinata (piksel)."},
                "y": {"type": "integer", "description": "Y koordinata (piksel)."},
                "duration": {"type": "number", "description": "Ko'chish davomiyligi soniyada (ixtiyoriy, standart 0.2)."},
            },
            "required": ["x", "y"],
        },
    },
    {
        "name": "pc_mouse_click",
        "description": "Windows kompyuterda sichqonchani bosadi — koordinata berilsa avval o'sha nuqtaga ko'chib, so'ng bosadi; berilmasa joriy pozitsiyada bosadi.",
        "input_schema": {
            "type": "object",
            "properties": {
                "x": {"type": "integer", "description": "X koordinata (ixtiyoriy)."},
                "y": {"type": "integer", "description": "Y koordinata (ixtiyoriy)."},
                "button": {"type": "string", "enum": ["left", "right", "middle"], "description": "Qaysi tugma (standart: left)."},
                "clicks": {"type": "integer", "description": "Necha marta bosish (standart: 1)."},
                "double": {"type": "boolean", "description": "true bo'lsa — double-click."},
            },
        },
    },
    {
        "name": "pc_mouse_scroll",
        "description": "Windows kompyuterda sahifani skroll qiladi. Musbat son — yuqoriga, manfiy son — pastga.",
        "input_schema": {
            "type": "object",
            "properties": {
                "amount": {"type": "integer", "description": "Skroll miqdori, masalan -500 (pastga) yoki 500 (yuqoriga)."},
                "x": {"type": "integer", "description": "Skroll qilinadigan X koordinata (ixtiyoriy)."},
                "y": {"type": "integer", "description": "Skroll qilinadigan Y koordinata (ixtiyoriy)."},
            },
            "required": ["amount"],
        },
    },
    {
        "name": "pc_mouse_drag",
        "description": "Windows kompyuterda sichqonchani bir nuqtadan boshqasiga bosib turgan holda sudrab boradi (drag & drop).",
        "input_schema": {
            "type": "object",
            "properties": {
                "from_x": {"type": "integer"},
                "from_y": {"type": "integer"},
                "to_x": {"type": "integer"},
                "to_y": {"type": "integer"},
                "button": {"type": "string", "enum": ["left", "right", "middle"], "description": "Standart: left."},
            },
            "required": ["from_x", "from_y", "to_x", "to_y"],
        },
    },
    {
        "name": "pc_key_press",
        "description": "Windows kompyuterda klaviatura tugmasini yoki tugma kombinatsiyasini bosadi (masalan 'enter', 'esc', 'ctrl+c', 'alt+tab', 'win+d').",
        "input_schema": {
            "type": "object",
            "properties": {
                "keys": {"type": "string", "description": "'+' bilan ajratilgan tugma(lar), masalan 'ctrl+s' yoki 'enter'."}
            },
            "required": ["keys"],
        },
    },
    {
        "name": "pc_type_text",
        "description": "Windows kompyuterda joriy faol maydonga matn yozadi (klaviatura orqali, xuddi foydalanuvchi terayotgandek). Faqat lotin/ASCII belgilar uchun ishonchli ishlaydi.",
        "input_schema": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "Yoziladigan matn."}},
            "required": ["text"],
        },
    },
    {
        "name": "git_commit_and_push",
        "description": (
            "Windows kompyuterdagi repo papkasida barcha o'zgarishlarni commit qilib "
            "GitHub'ga (yoki boshqa remote'ga) push qiladi. Foydalanuvchi 'o'zgarishlarni "
            "saqla/push qil/commit qil' desa ishlating."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "commit_message": {"type": "string", "description": "Commit xabari."},
                "repo_path": {
                    "type": "string",
                    "description": "Repo papkasining to'liq manzili (ixtiyoriy — berilmasa, agent joriy ishlab turgan papkasi ishlatiladi).",
                },
                "branch": {
                    "type": "string",
                    "description": "Push qilinadigan branch nomi (ixtiyoriy).",
                },
            },
            "required": ["commit_message"],
        },
    },
    {
        "name": "github_create_pr",
        "description": "GitHub'da yangi Pull Request yaratadi (GITHUB_TOKEN va GITHUB_REPO sozlangan bo'lishi kerak).",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "PR sarlavhasi."},
                "head_branch": {"type": "string", "description": "O'zgarishlar joylashgan branch."},
                "body": {"type": "string", "description": "PR tavsifi (ixtiyoriy)."},
                "base_branch": {
                    "type": "string",
                    "description": "Qo'shilishi kerak bo'lgan asosiy branch (ixtiyoriy, standart: main).",
                },
            },
            "required": ["title", "head_branch"],
        },
    },
    {
        "name": "github_list_open_prs",
        "description": "GitHub repozitoriyasidagi barcha ochiq Pull Request'lar ro'yxatini qaytaradi.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "github_review_pr",
        "description": (
            "Berilgan raqamli Pull Request'ning diff (kod o'zgarishlari) matnini GitHub'dan "
            "olib beradi — shundan so'ng o'zingiz shu diff'ni o'qib, kod review sifatida "
            "xato, xavfsizlik va uslub bo'yicha fikr-mulohaza yozing."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"pr_number": {"type": "integer", "description": "PR raqami."}},
            "required": ["pr_number"],
        },
    },
    {
        "name": "github_post_pr_comment",
        "description": "Berilgan Pull Request'ga izoh (comment) qoldiradi — masalan kod review natijasini yozish uchun.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pr_number": {"type": "integer", "description": "PR raqami."},
                "comment": {"type": "string", "description": "Izoh matni."},
            },
            "required": ["pr_number", "comment"],
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
    if name == "notify_progress":
        return tool_notify_progress(tool_input.get("text", ""))
    if name == "pc_open_app":
        return tool_pc_open_app(tool_input.get("app_name", ""))
    if name == "pc_close_app":
        return tool_pc_close_app(tool_input.get("app_name", ""))
    if name == "pc_run_command":
        return tool_pc_run_command(tool_input.get("command", ""))
    if name == "pc_open_url":
        return tool_pc_open_url(tool_input.get("url", ""))
    if name == "pc_power":
        return tool_pc_power(tool_input.get("action", ""))
    if name == "pc_status":
        return tool_pc_status()
    if name == "pc_list_dir":
        return tool_pc_list_dir(tool_input.get("path", ""))
    if name == "pc_screen_size":
        return tool_pc_screen_size()
    if name == "pc_mouse_move":
        return tool_pc_mouse_move(
            int(tool_input.get("x", 0)),
            int(tool_input.get("y", 0)),
            float(tool_input.get("duration", 0.2)),
        )
    if name == "pc_mouse_click":
        return tool_pc_mouse_click(
            tool_input.get("x"),
            tool_input.get("y"),
            tool_input.get("button", "left"),
            int(tool_input.get("clicks", 1)),
            bool(tool_input.get("double", False)),
        )
    if name == "pc_mouse_scroll":
        return tool_pc_mouse_scroll(
            int(tool_input.get("amount", -300)),
            tool_input.get("x"),
            tool_input.get("y"),
        )
    if name == "pc_mouse_drag":
        return tool_pc_mouse_drag(
            int(tool_input.get("from_x", 0)),
            int(tool_input.get("from_y", 0)),
            int(tool_input.get("to_x", 0)),
            int(tool_input.get("to_y", 0)),
            tool_input.get("button", "left"),
        )
    if name == "pc_key_press":
        return tool_pc_key_press(tool_input.get("keys", ""))
    if name == "pc_type_text":
        return tool_pc_type_text(tool_input.get("text", ""))
    if name == "git_commit_and_push":
        return tool_git_commit_and_push(
            tool_input.get("commit_message", ""),
            tool_input.get("repo_path", ""),
            tool_input.get("branch", ""),
        )
    if name == "github_create_pr":
        try:
            return tool_github_create_pr(
                tool_input.get("title", ""),
                tool_input.get("head_branch", ""),
                tool_input.get("body", ""),
                tool_input.get("base_branch", ""),
            )
        except RuntimeError as e:
            return str(e)
    if name == "github_list_open_prs":
        try:
            return tool_github_list_open_prs()
        except RuntimeError as e:
            return str(e)
    if name == "github_review_pr":
        try:
            return tool_github_review_pr(int(tool_input.get("pr_number", -1)))
        except RuntimeError as e:
            return str(e)
    if name == "github_post_pr_comment":
        try:
            return tool_github_post_pr_comment(
                int(tool_input.get("pr_number", -1)), tool_input.get("comment", "")
            )
        except RuntimeError as e:
            return str(e)
    return f"Noma'lum tool: {name}"


# ------------------------------------------------------------------
# 4) CLAUDE API BILAN GAPLASHISH
# ------------------------------------------------------------------

CLAUDE_API_URL = "https://api.anthropic.com/v1/messages"


def build_system_prompt() -> str:
    now = datetime.datetime.now().isoformat(timespec="seconds")
    return (
        "Sen Vera ismli, foydalanuvchiga shaxsan xizmat qiladigan, ayol ovozida gapiradigan "
        "sun'iy intellekt yordamchisisan. Har doim o'zbek tilida, tabiiy, samimiy va "
        "qisqa-lo'nda javob ber. "
        "Javobing keyinchalik ovozda ham o'qiladi, shuning uchun markdown belgilari "
        "(*, #, ``` va h.k.) ishlatma — oddiy, gapirishga mos matn yoz. "
        f"Hozirgi aniq sana va vaqt: {now}. "
        "Agar foydalanuvchi eslatma qo'shish, ko'rish yoki o'chirishni so'rasa, mos tool'dan "
        "foydalan. Nisbiy vaqtlarni ('ertaga', 'yarim soatdan keyin') hozirgi vaqtga qarab "
        "aniq ISO sanaga aylantirib ber. Agar uzoq davom etadigan vazifa (masalan loyiha "
        "ustida ishlash, kod yozish) haqida gap ketsa va foydalanuvchi keyinroq holatini "
        "bilishi kerak bo'lsa, notify_progress tool'idan foydalanib bildirishnoma yubor. "
        "Agar foydalanuvchi Windows kompyuterini boshqarishni so'rasa (dastur ochish/yopish, "
        "terminal buyrug'i, sayt ochish, kompyuterni qulflash/o'chirish/qayta yuklash, "
        "kompyuter holatini bilish) — mos pc_* tool'laridan foydalan. Agar foydalanuvchi "
        "kompyuterdagi biror papkada nima borligini so'rasa, pc_list_dir tool'idan "
        "foydalan. Agar kompyuter javob bermasa (timeout), foydalanuvchiga buni tabiiy "
        "tilda tushuntir va Windows agent dasturi ishlab turganini tekshirishni "
        "tavsiya qil. "
        "Agar foydalanuvchi kod o'zgarishlarini saqlash/push qilishni so'rasa — "
        "git_commit_and_push tool'idan foydalan (bu Windows agent orqali ishlaydi, "
        "shuning uchun kompyuter ochiq va repo shu yerda bo'lishi kerak). GitHub'dagi "
        "Pull Request'lar bilan ishlash uchun (ro'yxatini ko'rish, yangisini ochish, "
        "diff'ni o'qib review yozish, izoh qoldirish) — github_list_open_prs, "
        "github_create_pr, github_review_pr va github_post_pr_comment tool'laridan "
        "foydalan. Agar bu tool'lar 'GitHub sozlanmagan' deb xato qaytarsa, "
        "foydalanuvchiga serverda GITHUB_TOKEN va GITHUB_REPO muhit o'zgaruvchilarini "
        "sozlash kerakligini tushuntir."
    )


def call_claude(messages: List[dict]) -> str:
    if not ANTHROPIC_API_KEY or "BU_YERGA" in ANTHROPIC_API_KEY:
        return (
            "Claude API kaliti sozlanmagan. vera_backend.py faylidagi "
            "ANTHROPIC_API_KEY qiymatini to'ldiring."
        )

    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

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
            err_msg = f"Claude API xatosi ({resp.status_code}): {resp.text[:300]}"
            add_notification("error", err_msg, also_telegram=False)
            return err_msg

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


# Gap oxirini aniqlash uchun: '.', '!', '?', '…' dan keyingi bo'shliqda
# bo'lamiz. Bu orqali Claude javobni hali to'liq yozib bo'lmasdan turib,
# tayyor bo'lgan birinchi gapni darhol frontendga (va u orqali TTS'ga)
# yuborish mumkin bo'ladi — shu narsa javobni "odamdek tez" qiladi.
_SENTENCE_END_RE = re.compile(r"(?<=[.!?\u2026])\s+")


def call_claude_stream(messages: List[dict]):
    """call_claude bilan bir xil ishlaydi (tool-chaqiruvlarni ham qo'llab-
    quvvatlaydi), lekin natijani bitta katta matn sifatida emas, balki
    tayyor bo'lgan GAPLAR (jumlalar) oqimi sifatida generator orqali
    qaytaradi. Shu tufayli chaqiruvchi (masalan /chat_stream endpoint)
    Claude hali javobni "yozib" turgan paytdayoq birinchi gapni darhol
    ovozga aylantirib yuborishi mumkin — foydalanuvchi butun javobni
    kutmaydi, Vera odamdek tez javob qaytargandek tuyuladi."""
    if not ANTHROPIC_API_KEY or "BU_YERGA" in ANTHROPIC_API_KEY:
        yield ("Claude API kaliti sozlanmagan. vera_backend.py faylidagi "
               "ANTHROPIC_API_KEY qiymatini to'ldiring.")
        return

    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    conversation = list(messages)

    for _ in range(5):  # tool-chaqiruv aylanalari uchun limit
        payload = {
            "model": CLAUDE_MODEL,
            "max_tokens": 1024,
            "system": build_system_prompt(),
            "messages": conversation,
            "tools": TOOLS_SCHEMA,
            "stream": True,
        }

        buffer = ""  # navbatdagi (hali tugamagan) gapni yig'ib boradi
        blocks: dict[int, dict] = {}  # index -> {"type": ..., "text"/"json": ...}
        stop_reason = None
        event_name = None

        try:
            with requests.post(
                CLAUDE_API_URL, headers=headers, json=payload, timeout=90, stream=True
            ) as resp:
                if resp.status_code != 200:
                    err_msg = f"Claude API xatosi ({resp.status_code}): {resp.text[:300]}"
                    add_notification("error", err_msg, also_telegram=False)
                    yield err_msg
                    return

                for raw_line in resp.iter_lines(decode_unicode=True):
                    if not raw_line:
                        continue
                    if raw_line.startswith("event:"):
                        event_name = raw_line[len("event:"):].strip()
                        continue
                    if not raw_line.startswith("data:"):
                        continue
                    data_str = raw_line[len("data:"):].strip()
                    if not data_str:
                        continue
                    try:
                        evt = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue

                    if event_name == "content_block_start":
                        idx = evt["index"]
                        block = evt["content_block"]
                        btype = block.get("type")
                        if btype in ("tool_use", "server_tool_use"):
                            # "tool_use" — Claude o'zi bajarolmaydigan (pc_*,
                            # add_reminder va h.k.) buyruqlar; "server_tool_use"
                            # — Claude'ning o'zi ichki bajaradigan hosted
                            # vositalar (masalan web_search). Ikkalasi ham
                            # input_json_delta orqali argumentlarini oqim
                            # shaklida yuboradi, shuning uchun bir xil tarzda
                            # yig'amiz.
                            blocks[idx] = {
                                "type": btype,
                                "name": block.get("name"),
                                "id": block.get("id"),
                                "json": "",
                            }
                        elif btype == "text":
                            blocks[idx] = {"type": "text", "text": ""}
                        else:
                            # Masalan "web_search_tool_result" — bu blok
                            # to'liq holda content_block_start'ning o'zida
                            # keladi (keyin delta kelmaydi), shuning uchun
                            # o'zgarishsiz saqlab qo'yamiz va oxirida
                            # bo'lgan-bo'lganicha conversation'ga qaytaramiz.
                            blocks[idx] = {"type": "passthrough", "raw": block}

                    elif event_name == "content_block_delta":
                        idx = evt["index"]
                        if idx not in blocks:
                            continue
                        b = blocks[idx]
                        delta = evt.get("delta", {})
                        dtype = delta.get("type")
                        if dtype == "text_delta" and b["type"] == "text":
                            piece = delta.get("text", "")
                            b["text"] += piece
                            buffer += piece
                            parts = _SENTENCE_END_RE.split(buffer)
                            if len(parts) > 1:
                                for sent in parts[:-1]:
                                    sent = sent.strip()
                                    if sent:
                                        yield sent
                                buffer = parts[-1]
                        elif dtype == "input_json_delta" and b["type"] in (
                            "tool_use", "server_tool_use",
                        ):
                            b["json"] += delta.get("partial_json", "")
                        # citations_delta va boshqa turlar — hozircha e'tiborsiz
                        # qoldiramiz (funksionallikka ta'sir qilmaydi).

                    elif event_name == "message_delta":
                        sr = evt.get("delta", {}).get("stop_reason")
                        if sr:
                            stop_reason = sr

                    elif event_name == "message_stop":
                        break
        except requests.RequestException as e:
            yield f"Ulanishda xato: {e}"
            return

        leftover = buffer.strip()
        if leftover:
            yield leftover

        content_blocks = []
        for idx in sorted(blocks):
            b = blocks[idx]
            if b["type"] == "text":
                content_blocks.append({"type": "text", "text": b["text"]})
            elif b["type"] == "passthrough":
                content_blocks.append(b["raw"])
            else:
                try:
                    tool_input = json.loads(b["json"]) if b["json"] else {}
                except json.JSONDecodeError:
                    tool_input = {}
                content_blocks.append(
                    {"type": b["type"], "id": b["id"], "name": b["name"], "input": tool_input}
                )
        conversation.append({"role": "assistant", "content": content_blocks})

        # Faqat "tool_use" (Claude o'zi bajarolmaydigan, biz bajarishimiz
        # kerak bo'lgan) chaqiruvlarga javob qaytaramiz. "server_tool_use"
        # (masalan web_search) allaqachon Claude tomonidan bajarilgan va
        # natijasi (web_search_tool_result) shu javobning ichida keladi —
        # unga alohida tool_result yubormaymiz.
        if stop_reason == "tool_use" and any(
            b.get("type") == "tool_use" for b in content_blocks
        ):
            tool_results = []
            for b in content_blocks:
                if b.get("type") == "tool_use":
                    result_text = run_tool(b["name"], b.get("input", {}))
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": b["id"],
                            "content": result_text,
                        }
                    )
            conversation.append({"role": "user", "content": tool_results})
            continue  # tool natijasi bilan yakuniy (matnli) javobni yana stream qilamiz

        return  # yakuniy matnli javob tugadi

    yield "Kechirasiz, so'rovni bajarishda muammo yuzaga keldi (tool aylana limiti)."


def process_user_message(user_text: str, channel: str) -> str:
    save_message("user", user_text, channel)
    history = get_recent_history(limit=16)
    reply = call_claude(history)
    save_message("assistant", reply, channel)
    return reply


def process_user_image(image_b64: str, media_type: str, caption: str, channel: str) -> str:
    """Skrinshot/kod rasmi yoki oddiy foto yuborilganda ishlaydi. Rasmni
    Claude'ning vision imkoniyati orqali tahlil qildiradi va natijani oddiy
    suhbat tarixiga ham yozadi, shunda keyingi savollarda ("bu xatoni qanday
    tuzataman?") kontekst saqlanadi."""
    user_label = caption.strip() if caption.strip() else "(rasm yuborildi)"
    save_message("user", user_label, channel)
    history = get_recent_history(limit=16)
    # Oxirgi (hozirgina saqlangan) matnli xabarni rasm bilan almashtiramiz,
    # chunki Claude API'ga rasm alohida content-blok sifatida yuborilishi kerak.
    if history and history[-1]["role"] == "user":
        history = history[:-1]
    history.append(
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": image_b64,
                    },
                },
                {
                    "type": "text",
                    "text": caption.strip() or (
                        "Bu rasmda nima ko'rsatilganini tahlil qil. Agar bu "
                        "kod yoki xato skrinshoti bo'lsa, sababini tushuntirib, "
                        "yechim taklif qil."
                    ),
                },
            ],
        }
    )
    reply = call_claude(history)
    save_message("assistant", reply, channel)
    return reply


# ------------------------------------------------------------------
# 5) FON JARAYONI — eslatmalarni tekshirish
# ------------------------------------------------------------------

pending_notifications: List[dict] = []
_pending_lock = threading.Lock()


def add_notification(ntype: str, text: str, also_telegram: bool = True) -> str:
    """Bildirishnomalar markaziga yozadi (ilova /notifications orqali o'qiydi)
    va, agar so'ralsa, Telegram orqali ham darhol xabar beradi. Reminder,
    task holati (masalan "loyiha tayyor bo'ldi") va xatoliklar shu orqali
    ilovaga yetib boradi."""
    now_iso = datetime.datetime.now().isoformat()
    with _db_lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            f"INSERT INTO notifications(type, text, created_at) VALUES ({PARAM}, {PARAM}, {PARAM})",
            (ntype, text, now_iso),
        )
        conn.commit()
        cur.close()
        conn.close()
    if also_telegram:
        icon = {"reminder": "⏰", "task": "✅", "error": "⚠️"}.get(ntype, "🔔")
        send_telegram_message(f"{icon} {text}")
    return "Bildirishnoma yuborildi."


def tool_notify_progress(text: str) -> str:
    """Claude tool sifatida chaqiradi — masalan uzoq vazifa ustida ishlayotganda
    ('loyihani boshladim', '50% tayyor') yoki tugaganda ('loyiha tayyor bo'ldi')
    foydalanuvchiga xabar berish uchun."""
    return add_notification("task", text)


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
                add_notification("reminder", f"Eslatma: {r[1]}")
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
# 6.5) OVOZ (TTS) — MadinaNeural orqali matnni ovozga aylantirish
# ------------------------------------------------------------------

_EMOJI_PATTERN = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\u2190-\u21FF\u2B00-\u2BFF]+"
)


def prepare_text_for_speech(raw: str) -> str:
    """Matnni ovozli o'qish uchun tozalaydi (Flutter tomonidagi mantiqning
    server tarafidagi nusxasi — Telegram va boshqa kanallar uchun ham
    bir xil tozalash ishlashi uchun)."""
    t = raw

    # Turli apostrofsimon belgilarni standart shaklga keltiramiz.
    t = re.sub(r"[\u2019\u2018`\u00b4]", "'", t)

    # o'/g' (va O'/G') dagi apostrofni maxsus modifikator harfga
    # (ʻ, U+02BB) almashtiramiz — tabiiy o'zbekcha talaffuz uchun.
    t = re.sub(r"([oOgG])'", lambda m: m.group(1) + "\u02bb", t)

    # Emoji va nutqqa aloqasi yo'q belgilarni olib tashlaymiz.
    t = _EMOJI_PATTERN.sub("", t)

    # Markdown/ro'yxat belgilarini olib tashlaymiz.
    t = re.sub(r"[*_#`~]", "", t)
    t = re.sub(r"^[•\-]\s*", "", t, flags=re.MULTILINE)

    # Ortiqcha bo'sh joy va qatorlarni yig'ishtiramiz.
    t = re.sub(r"\s+", " ", t).strip()

    # Xavfsizlik to'ri: matnda buzilgan/juft bo'lmagan surrogat belgilar
    # bo'lishi mumkin (masalan, bazadan yoki JSON orqali noto'g'ri
    # saqlangan emoji "yarmi"). Bunday belgilar UTF-8'ga kodlanganda
    # UnicodeEncodeError berib, edge-tts'ni butunlay ishdan chiqaradi.
    # Shuning uchun kodlab bo'lmaydigan har qanday belgini xavfsiz olib
    # tashlaymiz — bu yaxshi matnga ta'sir qilmaydi, faqat buzilganini
    # tozalaydi.
    t = t.encode("utf-8", errors="ignore").decode("utf-8", errors="ignore")

    return t


async def synthesize_speech(
    text: str, rate_percent: int = 0, pitch_percent: int = 0
) -> bytes:
    """OpenAI'ning nutq sintezi (audio/speech) API'si orqali MP3 baytlarini
    generatsiya qiladi.

    rate_percent: -50..+50 oralig'ida, gapirish tezligiga ta'sir qiladi
    (OpenAI'ning "speed" parametriga 0.5..1.5 oralig'iga moslab
    aylantiriladi).
    pitch_percent: OpenAI TTS API'sida alohida "balandlik" parametri yo'q,
    shuning uchun bu qiymat "instructions" matni ichida ohang tavsifi
    sifatida beriladi (gpt-4o-mini-tts buni tushunadi).

    Railway kabi bulutli serverlarda vaqti-vaqti bilan tarmoq xatosi
    chiqishi mumkin, shuning uchun bir necha marta qayta urinamiz.
    """
    if not OPENAI_API_KEY or "BU_YERGA" in OPENAI_API_KEY:
        raise RuntimeError(
            "OpenAI API kaliti sozlanmagan. Serverda OPENAI_API_KEY "
            "muhit o'zgaruvchisini o'rnating."
        )

    # -50..+50 % ni OpenAI kutadigan 0.5..1.5 tezlik ko'paytiruvchisiga
    # aylantiramiz (0% -> 1.0x).
    speed = max(0.5, min(1.5, 1.0 + (rate_percent / 100.0)))

    instructions = VERA_VOICE_STYLE
    if pitch_percent > 10:
        instructions += " Ovozing biroz balandroq va yoshroq jarangla."
    elif pitch_percent < -10:
        instructions += " Ovozing biroz pastroq va sokinroq jarangla."

    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": OPENAI_TTS_MODEL,
        "voice": VERA_VOICE,
        "input": text,
        "response_format": "mp3",
        "speed": round(speed, 2),
    }
    # "instructions" faqat gpt-4o-mini-tts kabi yangi modellarda ishlaydi;
    # eski tts-1/tts-1-hd buni e'tiborsiz qoldiradi yoki xato qaytarishi
    # mumkin, shuning uchun faqat yangi model tanlanganda qo'shamiz.
    if "mini-tts" in OPENAI_TTS_MODEL or "gpt-4o" in OPENAI_TTS_MODEL:
        payload["instructions"] = instructions

    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            # MUHIM: requests.post() bloklovchi (sinxron) chaqiruv. Buni
            # asyncio.to_thread() bilan alohida oqimga chiqarmasak, u
            # butun event loop'ni ushlab turadi — shu paytda boshqa hech
            # qanday so'rov (jumladan PARALEL kelayotgan keyingi gaplar
            # uchun /speak so'rovlari!) qayta ishlanmaydi. Aynan shu
            # narsa Vera'ni sezilarli darajada sekinlashtirgan edi.
            resp = await asyncio.to_thread(
                requests.post,
                "https://api.openai.com/v1/audio/speech",
                headers=headers,
                json=payload,
                timeout=60,
            )
            if resp.status_code != 200:
                raise RuntimeError(
                    f"OpenAI TTS xatosi ({resp.status_code}): {resp.text[:300]}"
                )
            audio_bytes = resp.content
            if not audio_bytes:
                raise RuntimeError("OpenAI TTS bo'sh audio qaytardi (0 bayt)")
            if attempt > 1:
                print(f"[TTS] {attempt}-urinishda muvaffaqiyatli bo'ldi.")
            return audio_bytes
        except Exception as e:
            last_error = e
            print(f"[TTS XATO] {attempt}-urinish muvaffaqiyatsiz: "
                  f"{type(e).__name__}: {e}")
            if attempt < 3:
                await asyncio.sleep(1.5 * attempt)

    raise RuntimeError(
        f"OpenAI TTS 3 marta urinishdan keyin ham ishlamadi: "
        f"{type(last_error).__name__}: {last_error}"
    )


def tighten_pauses(
    audio_bytes: bytes, max_pause_ms: int = 180, fade_ms: int = 12
) -> bytes:
    """Gaplar orasidagi uzun jim (pauza) joylarni qisqartiradi, shunda
    Vera odamdek — gaplarni deyarli qo'shib, tabiiy nafas oralig'i bilan
    gapiradi. Microsoft edge-tts xizmati SSML <break> teglariga ruxsat
    bermaydi (faqat rate/pitch/volume), shuning uchun buni tayyor MP3
    ustida audio darajasida bajaramiz.

    ESLATMA: oldingi versiyada bo'laklarni CROSSFADE (bir-biriga
    aralashtirib) ulash ishlatilgan edi — bu bir so'zning oxirgi tovushini
    keyingi so'zning boshlang'ich tovushiga aralashtirib yuborib,
    talaffuzni buzardi va aynan shu "buzilish" eshituvchiga sezilib
    qolardi. Shuning uchun endi CROSSFADE o'rniga har bir nutq bo'lagining
    boshi/oxiriga juda qisqa (bir necha millisekundlik) FADE (ovoz
    balandligini asta pasaytirish/ko'tarish, mazmunga tegmasdan) qo'llanadi
    — bu faqat kesilgan joydagi "klik" tovushining oldini oladi, so'zlarni
    bir-biriga aralashtirmaydi. Pauzaning o'zi esa aralashtirilmasdan,
    shunchaki qisqartirilgan holda saqlanadi.

    Agar biror sababdan ishlov muvaffaqiyatsiz bo'lsa, asl audio
    o'zgarishsiz qaytariladi — ovoz baribir eshitiladi, faqat pauzalar
    qisqarmagan bo'ladi.
    """
    try:
        audio = AudioSegment.from_file(io.BytesIO(audio_bytes), format="mp3")
        silences = detect_silence(
            audio, min_silence_len=280, silence_thresh=audio.dBFS - 16
        )
        if not silences:
            return audio_bytes

        result = AudioSegment.empty()
        prev_end = 0
        for start, end in silences:
            speech = audio[prev_end:start]
            if len(speech) > fade_ms * 2:
                speech = speech.fade_in(fade_ms).fade_out(fade_ms)
            result += speech
            pause_len = min(end - start, max_pause_ms)
            result += AudioSegment.silent(duration=pause_len)
            prev_end = end

        tail = audio[prev_end:]
        if len(tail) > fade_ms * 2:
            tail = tail.fade_in(fade_ms)
        result += tail

        out = io.BytesIO()
        result.export(out, format="mp3")
        return out.getvalue()
    except Exception as e:
        print(f"[TTS] Pauza qisqartirishda xato (asl audio ishlatiladi): "
              f"{type(e).__name__}: {e}")
        return audio_bytes




class SpeakRequest(BaseModel):
    text: str
    rate_percent: int = 0
    pitch_percent: int = 0


# ------------------------------------------------------------------
# 7) HTTP API (Flutter ilova shu bilan gaplashadi)
# ------------------------------------------------------------------

app = FastAPI(title="Vera Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str


class ChatImageRequest(BaseModel):
    image_base64: str
    media_type: str = "image/png"
    caption: str = ""


class NotificationReadRequest(BaseModel):
    id: int | None = None  # None bo'lsa — barchasi o'qilgan deb belgilanadi


@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.datetime.now().isoformat()}


@app.get("/chat_history")
def chat_history(limit: int = 200):
    """Ilova ochilganda (yoki boshqa qurilmadan kirilganda) oldingi
    yozishmalarni ko'rsatish uchun. Barcha xabarlar bitta umumiy bazada
    saqlangani sababli, qaysi qurilmadan so'ralsa ham bir xil (yagona)
    suhbat tarixi qaytadi."""
    return {"messages": get_chat_history_for_display(limit=limit)}


@app.post("/chat")
def chat(req: ChatRequest):
    reply = process_user_message(req.message, channel="app")
    return {"reply": reply}


@app.post("/chat_stream")
def chat_stream(req: ChatRequest):
    """/chat bilan bir xil ishlaydi, lekin javobni bitta butun matn
    sifatida emas, balki har bir gap tayyor bo'lishi bilanoq alohida
    voqea (SSE — Server-Sent Events) sifatida qaytaradi. Flutter ilova
    har bir gapni kelishi bilan darhol ovozga aylantirib, navbat bilan
    ijro etadi — shu sababli Vera butun javobni "o'ylab" chiqquncha
    kutish o'rniga, odamga o'xshab tezroq gapira boshlaydi."""
    save_message("user", req.message, "app")
    history = get_recent_history(limit=16)

    def event_gen():
        full_parts: list[str] = []
        try:
            for sentence in call_claude_stream(history):
                full_parts.append(sentence)
                payload = json.dumps({"sentence": sentence}, ensure_ascii=False)
                yield f"data: {payload}\n\n"
        except Exception as e:
            err = json.dumps({"error": str(e)}, ensure_ascii=False)
            yield f"data: {err}\n\n"
        finally:
            full_reply = " ".join(full_parts).strip() or "(bo'sh javob)"
            save_message("assistant", full_reply, "app")
            done = json.dumps({"done": True}, ensure_ascii=False)
            yield f"data: {done}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream")


@app.post("/chat_image")
def chat_image(req: ChatImageRequest):
    """Ilovadan skrinshot/kod rasmi yoki galereya rasmi yuborilganda ishlatiladi."""
    if not req.image_base64:
        raise HTTPException(status_code=400, detail="Rasm ma'lumoti bo'sh")
    try:
        reply = process_user_image(req.image_base64, req.media_type, req.caption, channel="app")
    except Exception as e:
        add_notification("error", f"Rasm tahlilida xato: {e}", also_telegram=False)
        raise HTTPException(status_code=502, detail=f"Rasmni tahlil qilishda xato: {e}")
    return {"reply": reply}


@app.get("/notifications")
def list_notifications(limit: int = 50):
    with _db_lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            f"SELECT id, type, text, is_read, created_at FROM notifications "
            f"ORDER BY id DESC LIMIT {PARAM}",
            (limit,),
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
    return {
        "notifications": [
            {
                "id": r[0],
                "type": r[1],
                "text": r[2],
                "is_read": bool(r[3]),
                "created_at": r[4],
            }
            for r in rows
        ]
    }


@app.post("/notifications/read")
def mark_notifications_read(req: NotificationReadRequest):
    with _db_lock:
        conn = get_conn()
        cur = conn.cursor()
        if req.id is None:
            cur.execute("UPDATE notifications SET is_read = 1 WHERE is_read = 0")
        else:
            cur.execute(
                f"UPDATE notifications SET is_read = 1 WHERE id = {PARAM}", (req.id,)
            )
        conn.commit()
        cur.close()
        conn.close()
    return {"status": "ok"}


@app.post("/speak")
async def speak(req: SpeakRequest):
    clean_text = prepare_text_for_speech(req.text)
    if not clean_text:
        raise HTTPException(status_code=400, detail="Ovozga aylantirish uchun matn bo'sh")
    try:
        # Xat-boshi juda uzun bo'lsa (masalan uzun tushuntirish), edge-tts
        # baribir bajaradi, lekin javob vaqtini cheklash uchun kesamiz.
        audio_bytes = await synthesize_speech(
            clean_text[:2000], req.rate_percent, req.pitch_percent
        )
        # Gaplar orasidagi uzun pauzalarni qisqartiramiz. Yangi versiya
        # CROSSFADE emas, faqat FADE ishlatadi (yuqoridagi izohga qarang),
        # shuning uchun endi talaffuzni buzmasdan xavfsiz qo'llash mumkin.
        # tighten_pauses() ffmpeg subprocess chaqiradi va CPU'ni band
        # qiladi — shuni ham alohida oqimga chiqaramiz, aks holda bu ham
        # event loop'ni bloklab, boshqa PARALEL /speak so'rovlarini
        # kutdirib qo'yadi.
        audio_bytes = await asyncio.to_thread(tighten_pauses, audio_bytes)
    except Exception as e:
        print(f"[SPEAK ENDPOINT XATO] {type(e).__name__}: {e}")
        raise HTTPException(status_code=502, detail=f"Ovoz xizmati xatosi: {e}")
    return Response(content=audio_bytes, media_type="audio/mpeg")


class TranscribeRequest(BaseModel):
    audio_base64: str
    format: str = "m4a"


# Ovozni matnga aylantirish uchun OpenAI modeli. MUHIM: "gpt-4o-mini-transcribe"
# "language": "uz" parametrini tan olmaydi va 400 xato bilan qaytaradi
# ("Language code 'uz' is not recognized") — aynan shu Vera'ni "hech narsa
# eshitmayapti"dek qilib qo'ygan edi. "whisper-1" esa o'zbek tilini
# to'liq qo'llab-quvvatlaydi, shuning uchun standart qilib shuni qo'ydik.
OPENAI_STT_MODEL = os.environ.get("OPENAI_STT_MODEL", "whisper-1")


@app.post("/transcribe")
async def transcribe_audio(req: TranscribeRequest):
    """Telefon/kompyuter ilovasi foydalanuvchi gapini yozib olib, shu yerga
    yuboradi — biz uni OpenAI'ning nutqni matnga aylantirish (STT) API'siga
    uzatamiz va tanilgan matnni qaytaramiz."""
    if not OPENAI_API_KEY or "BU_YERGA" in OPENAI_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="OpenAI API kaliti sozlanmagan. Serverda OPENAI_API_KEY o'rnating.",
        )
    try:
        audio_bytes = base64.b64decode(req.audio_base64)
    except Exception:
        raise HTTPException(status_code=400, detail="audio_base64 noto'g'ri formatda.")
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio ma'lumoti bo'sh.")

    ext = (req.format or "m4a").lstrip(".")
    files = {"file": (f"audio.{ext}", audio_bytes, f"audio/{ext}")}
    data = {"model": OPENAI_STT_MODEL}
    # Faqat whisper-1 "language" parametrini ISO-639-1 kod ("uz") sifatida
    # to'g'ri qabul qiladi. gpt-4o-* transkripsiya modellari buni rad etadi
    # (400 xato) — shuning uchun ular uchun tilni "prompt" ichida so'z
    # bilan ko'rsatamiz, bu ham tanishni o'zbek tiliga yo'naltiradi.
    if OPENAI_STT_MODEL.startswith("whisper"):
        data["language"] = "uz"
    else:
        data["prompt"] = "Bu audio o'zbek tilida (Uzbek language) so'zlashuv."
    try:
        # Bu ham bloklovchi chaqiruv edi — event loop'ni butun so'rov
        # davomida (audio yuklash + Whisper qayta ishlash, ba'zan bir
        # necha soniya) ushlab turardi, shu paytda server boshqa hech
        # qanday so'rovni (hatto /health'ni ham) qabul qila olmasdi.
        resp = await asyncio.to_thread(
            requests.post,
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            files=files,
            data=data,
            timeout=30,
        )
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"OpenAI STT so'rovida xato: {e}")
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"OpenAI STT xatosi ({resp.status_code}): {resp.text[:300]}",
        )
    text = (resp.json().get("text") or "").strip()
    return {"text": text}


@app.get("/reminders")
def list_reminders_endpoint():
    return json.loads(tool_list_reminders()) if tool_list_reminders() != "Hozircha faol eslatma yo'q." else []


@app.get("/pending_notifications")
def get_pending_notifications():
    with _pending_lock:
        items = pending_notifications.copy()
        pending_notifications.clear()
    return {"notifications": items}


# ------------------------------------------------------------------
# 7.5) WINDOWS AGENT bilan aloqa (windows_agent.py shu endpointlarni chaqiradi)
# ------------------------------------------------------------------

class AgentResultRequest(BaseModel):
    id: int
    status: str  # "done" yoki "error"
    result: str = ""


# Har bir agentning oxirgi so'nggi so'rov vaqti (xotirada, oddiy "onlaynmi" belgisi uchun)
agent_last_seen: dict[str, str] = {}


def _check_agent_token(token: str):
    if not AGENT_TOKEN or "O'ZGARTIRING" in AGENT_TOKEN:
        raise HTTPException(
            status_code=500,
            detail="AGENT_TOKEN sozlanmagan. Serverda AGENT_TOKEN muhit o'zgaruvchisini o'rnating.",
        )
    if token != AGENT_TOKEN:
        raise HTTPException(status_code=401, detail="Noto'g'ri agent token")


@app.get("/agent/next_command")
def agent_next_command(token: str, agent_name: str = DEFAULT_AGENT_NAME):
    """Windows agent shu endpointni so'rab turadi. MUHIM: buyruq hali
    navbatda yo'q bo'lsa, darhol bo'sh javob qaytarish o'rniga bir necha
    soniya "kutib turamiz" (long-polling) — shu paytda yangi buyruq kelsa,
    darhol qaytariladi. Shu bilan agent'ning navbatdagi so'rov yuborishini
    kutish shart bo'lmaydi va ketma-ket buyruqlar orasidagi kechikish
    sezilarli darajada qisqaradi (avval ~1.5s gacha, endi deyarli 0)."""
    _check_agent_token(token)
    agent_last_seen[agent_name] = datetime.datetime.now().isoformat()

    def _try_fetch():
        with _db_lock:
            conn = get_conn()
            cur = conn.cursor()
            cur.execute(
                f"SELECT id, action, params FROM pc_commands "
                f"WHERE status = 'pending' AND agent_name = {PARAM} "
                f"ORDER BY id ASC LIMIT 1",
                (agent_name,),
            )
            row = cur.fetchone()
            if row:
                cur.execute(
                    f"UPDATE pc_commands SET status = 'sent' WHERE id = {PARAM}", (row[0],)
                )
                conn.commit()
            cur.close()
            conn.close()
        return row

    deadline = time.time() + AGENT_LONG_POLL_SEC
    while True:
        row = _try_fetch()
        if row:
            return {"command": {"id": row[0], "action": row[1], "params": json.loads(row[2])}}
        if time.time() >= deadline:
            return {"command": None}
        time.sleep(0.2)


@app.post("/agent/command_result")
def agent_command_result(req: AgentResultRequest, token: str):
    """Windows agent buyruqni bajargach, natijasini shu yerga yuboradi."""
    _check_agent_token(token)
    with _db_lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            f"UPDATE pc_commands SET status = {PARAM}, result = {PARAM}, completed_at = {PARAM} "
            f"WHERE id = {PARAM}",
            (req.status, req.result, datetime.datetime.now().isoformat(), req.id),
        )
        conn.commit()
        cur.close()
        conn.close()
    return {"status": "ok"}


@app.get("/agent/status")
def agent_connection_status(agent_name: str = DEFAULT_AGENT_NAME):
    """Ilova (Flutter) shu orqali 'kompyuter onlaynmi' degan holatni ko'rsatishi
    mumkin: oxirgi so'rov 15 soniyadan kam oldin bo'lsa — onlayn deymiz."""
    last_seen = agent_last_seen.get(agent_name)
    online = False
    if last_seen:
        elapsed = (datetime.datetime.now() - datetime.datetime.fromisoformat(last_seen)).total_seconds()
        online = elapsed < 15
    return {"last_seen": last_seen, "online": online}


@app.get("/agent/history")
def agent_command_history(limit: int = 30, agent_name: str = DEFAULT_AGENT_NAME):
    """'Vazifalar markazi' ekrani uchun: Windows agentga yuborilgan so'nggi
    buyruqlar va ularning natijalari (Flutter shu ro'yxatni jonli log sifatida
    ko'rsatadi)."""
    with _db_lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            f"SELECT id, action, params, status, result, created_at, completed_at "
            f"FROM pc_commands WHERE agent_name = {PARAM} "
            f"ORDER BY id DESC LIMIT {PARAM}",
            (agent_name, limit),
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
    return {
        "commands": [
            {
                "id": r[0],
                "action": r[1],
                "params": r[2],
                "status": r[3],
                "result": r[4],
                "created_at": r[5],
                "completed_at": r[6],
            }
            for r in rows
        ]
    }


class PcQuickActionRequest(BaseModel):
    action: str
    params: dict = {}


@app.post("/pc/quick_action")
def pc_quick_action(req: PcQuickActionRequest):
    """'Kompyuter' ekranidagi tugmalar (qulflash, ilova ochish va h.k.) shu
    endpoint orqali to'g'ridan-to'g'ri, Claude'siz ishlaydi — chat tarixiga
    yozilmaydi, faqat pc_commands jadvaliga tushadi."""
    if req.action not in {
        "open_app", "close_app", "run_shell_command", "open_url",
        "system_power", "get_system_status", "list_dir",
    }:
        raise HTTPException(status_code=400, detail=f"Noma'lum amal: {req.action}")
    result = run_pc_command_and_wait(req.action, req.params)
    return {"result": result}


@app.get("/github/prs")
def github_prs_endpoint():
    """'Vazifalar markazi' ekranida ochiq Pull Request'larni ko'rsatish uchun."""
    try:
        raw = tool_github_list_open_prs()
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if raw.startswith("Hozircha"):
        return {"prs": []}
    try:
        return {"prs": json.loads(raw)}
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail=raw)


# ------------------------------------------------------------------
# 8) ISHGA TUSHIRISH
# ------------------------------------------------------------------

if __name__ == "__main__":
    init_db()
    threading.Thread(target=reminder_checker_loop, daemon=True).start()
    threading.Thread(target=telegram_loop, daemon=True).start()
    print(f"Vera backend ishga tushdi: http://{HOST}:{PORT}")
    print("Ogohlantirish: maxfiy kalit tekshiruvi o'chirilgan — bu manzilni "
          "hech kimga bermang, aks holda har kim Vera bilan gaplasha oladi.")
    uvicorn.run(app, host=HOST, port=PORT)
