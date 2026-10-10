"""Mood tracker Telegram bot: asks one question a few times a day, reports weekly."""

import logging
import os
from datetime import date, datetime, timedelta, timezone
from functools import wraps
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes

from . import report
from .db import DB, User
from .schedule import check_in_times, parse_hhmm

log = logging.getLogger("moodbot")

QUESTION = "How are you feeling now?"
DEFAULT_START, DEFAULT_END, DEFAULT_PER_DAY = "09:00", "21:00", 2
ALLOWED = {int(x) for x in os.environ.get("ALLOWED_CHAT_IDS", "").replace(" ", "").split(",") if x}
DEFAULT_TZ = os.environ.get("DEFAULT_TZ", "Asia/Kolkata")

HELP = (
    "I ask “How are you feeling now?” a few times a day. Tap an answer, that's it.\n\n"
    "/settings – current schedule\n"
    "/settime 09:00 21:00 – first and last check-in\n"
    "/frequency 1-4 – check-ins per day, evenly spaced\n"
    "/timezone Europe/Berlin – your timezone\n"
    "/week /month /year – stats and chart\n"
    "/stop – pause check-ins, /start resumes"
)


def db(ctx: ContextTypes.DEFAULT_TYPE) -> DB:
    return ctx.bot_data["db"]


def allowed_only(fn):
    @wraps(fn)
    async def wrapper(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        chat = update.effective_chat
        if ALLOWED and (chat is None or chat.id not in ALLOWED):
            if update.message:
                await update.message.reply_text(f"This bot is private. Your chat id is {chat.id}.")
            return
        return await fn(update, ctx)

    return wrapper


# ---------- scheduling ----------

def unschedule(jq, chat_id: int) -> None:
    for job in jq.jobs():
        if job.name and job.name.startswith(f"{chat_id}:"):
            job.schedule_removal()


def schedule_user(app_or_ctx, u: User) -> None:
    jq = app_or_ctx.job_queue
    unschedule(jq, u.chat_id)
    if not u.active:
        return
    zone = ZoneInfo(u.tz)
    times = check_in_times(u.start_time, u.end_time, u.per_day)
    for i, t in enumerate(times):
        jq.run_daily(ask, t.replace(tzinfo=zone), chat_id=u.chat_id, name=f"{u.chat_id}:ask:{i}")

    # Weekly report: Sunday, 30 minutes after the last check-in of the day.
    last = (datetime.combine(date(2000, 1, 2), times[-1]) + timedelta(minutes=30))
    weekday = last.weekday()  # 6 = Sunday unless the +30 min crossed midnight
    jq.run_daily(weekly_report, last.time().replace(tzinfo=zone), days=(0 if weekday == 6 else 1,),
                 chat_id=u.chat_id, name=f"{u.chat_id}:weekly")
    # Monthly report: 1st of the month, at the first check-in.
    jq.run_monthly(monthly_report, times[0].replace(tzinfo=zone), day=1, chat_id=u.chat_id, name=f"{u.chat_id}:monthly")
    log.info("scheduled %s at %s (%s)", u.chat_id, [t.strftime("%H:%M") for t in times], u.tz)


def describe(u: User) -> str:
    times = ", ".join(t.strftime("%H:%M") for t in check_in_times(u.start_time, u.end_time, u.per_day))
    state = "active" if u.active else "paused"
    return (f"Check-ins: {u.per_day}× a day at {times} ({u.tz}), {state}.\n"
            f"Weekly report on Sunday evening, monthly report on the 1st.")


# ---------- jobs ----------

async def ask(ctx: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = ctx.job.chat_id
    pid = db(ctx).create_prompt(chat_id, datetime.now(timezone.utc))
    kb = InlineKeyboardMarkup([[
        InlineKeyboardButton(f"{report.EMOJI[m]} {report.LABEL[m]}", callback_data=f"m:{pid}:{m}")
        for m in report.MOODS
    ]])
    await ctx.bot.send_message(chat_id, QUESTION, reply_markup=kb)


async def send_report(ctx: ContextTypes.DEFAULT_TYPE, chat_id: int, start: date, end: date, title: str) -> None:
    u = db(ctx).get_user(chat_id)
    if u is None:
        return
    span = end - start
    prompts = db(ctx).prompts_between(chat_id, *report.to_utc_bounds(u.tz, start, end))
    previous = db(ctx).prompts_between(chat_id, *report.to_utc_bounds(u.tz, start - span, start))
    heading = f"{title} ({start:%d %b} – {end - timedelta(days=1):%d %b %Y})"
    text = report.summarize(prompts, previous, u.tz, heading)
    png = report.chart(prompts, u.tz, start, end, heading)
    if png:
        await ctx.bot.send_photo(chat_id, png)
    await ctx.bot.send_message(chat_id, f"<pre>{text}</pre>", parse_mode="HTML")


async def weekly_report(ctx: ContextTypes.DEFAULT_TYPE) -> None:
    u = db(ctx).get_user(ctx.job.chat_id)
    # Window ends at the (local) Sunday that just finished, even if the job ran past midnight.
    now = datetime.now(ZoneInfo(u.tz))
    sunday = now.date() - timedelta(days=(now.weekday() - 6) % 7)
    await send_report(ctx, u.chat_id, sunday - timedelta(days=6), sunday + timedelta(days=1), "Your week")


async def monthly_report(ctx: ContextTypes.DEFAULT_TYPE) -> None:
    u = db(ctx).get_user(ctx.job.chat_id)
    first_this = datetime.now(ZoneInfo(u.tz)).date().replace(day=1)
    first_prev = (first_this - timedelta(days=1)).replace(day=1)
    await send_report(ctx, u.chat_id, first_prev, first_this, f"{first_prev:%B}")


# ---------- handlers ----------

@allowed_only
async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    u = db(ctx).get_user(chat_id) or User(chat_id, DEFAULT_TZ, parse_hhmm(DEFAULT_START), parse_hhmm(DEFAULT_END),
                                         DEFAULT_PER_DAY, True)
    u.active = True
    db(ctx).upsert_user(u)
    schedule_user(ctx, u)
    await update.message.reply_text(f"Mood tracker is on.\n{describe(u)}\n\n{HELP}\n\nYour chat id: {chat_id}")


@allowed_only
async def cmd_stop(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    u = db(ctx).get_user(update.effective_chat.id)
    if u:
        u.active = False
        db(ctx).upsert_user(u)
        unschedule(ctx.job_queue, u.chat_id)
    await update.message.reply_text("Paused. Your data is kept. /start to resume.")


@allowed_only
async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(HELP)


@allowed_only
async def cmd_settings(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    u = db(ctx).get_user(update.effective_chat.id)
    await update.message.reply_text(describe(u) if u else "Send /start first.")


async def _update_user(update: Update, ctx: ContextTypes.DEFAULT_TYPE, change) -> None:
    u = db(ctx).get_user(update.effective_chat.id)
    if u is None:
        await update.message.reply_text("Send /start first.")
        return
    try:
        change(u)
        check_in_times(u.start_time, u.end_time, u.per_day)
    except (ValueError, IndexError, ZoneInfoNotFoundError) as e:
        await update.message.reply_text(f"Didn't work: {e}\n\n{HELP}")
        return
    db(ctx).upsert_user(u)
    schedule_user(ctx, u)
    await update.message.reply_text(f"Updated.\n{describe(u)}")


@allowed_only
async def cmd_settime(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    def change(u: User):
        if len(ctx.args) != 2:
            raise ValueError("give two times, e.g. /settime 09:00 21:00")
        u.start_time, u.end_time = parse_hhmm(ctx.args[0]), parse_hhmm(ctx.args[1])
    await _update_user(update, ctx, change)


@allowed_only
async def cmd_frequency(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    def change(u: User):
        n = int(ctx.args[0]) if ctx.args else 0
        if not 1 <= n <= 4:
            raise ValueError("frequency must be 1, 2, 3 or 4")
        u.per_day = n
    await _update_user(update, ctx, change)


@allowed_only
async def cmd_timezone(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    def change(u: User):
        if not ctx.args:
            raise ValueError("give an IANA timezone, e.g. /timezone Asia/Kolkata")
        ZoneInfo(ctx.args[0])
        u.tz = ctx.args[0]
    await _update_user(update, ctx, change)


def _period_cmd(days: int, title: str):
    @allowed_only
    async def handler(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
        u = db(ctx).get_user(update.effective_chat.id)
        if u is None:
            await update.message.reply_text("Send /start first.")
            return
        start, end = report.period(u.tz, days)
        await send_report(ctx, u.chat_id, start, end, title)
    return handler


@allowed_only
async def on_answer(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    try:
        _, pid, mood = q.data.split(":")
        pid = int(pid)
    except ValueError:
        await q.answer()
        return
    if mood not in report.MOODS:
        await q.answer()
        return
    if db(ctx).answer_prompt(pid, q.message.chat_id, mood, datetime.now(timezone.utc)):
        await q.answer("Noted")
        await q.edit_message_text(f"{QUESTION}\n{report.EMOJI[mood]} {report.LABEL[mood]}. Noted.")
    else:
        await q.answer("Already recorded")
        await q.edit_message_reply_markup(None)


async def post_init(app: Application) -> None:
    for u in app.bot_data["db"].active_users():
        schedule_user(app, u)
    await app.bot.set_my_commands([
        ("week", "Last 7 days"), ("month", "Last 30 days"), ("year", "Last 365 days"),
        ("settings", "Current schedule"), ("settime", "First and last check-in, e.g. 09:00 21:00"),
        ("frequency", "Check-ins per day, 1-4"), ("timezone", "e.g. Asia/Kolkata"),
        ("stop", "Pause check-ins"), ("start", "Start or resume"),
    ])


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise SystemExit("Set TELEGRAM_BOT_TOKEN")
    app = Application.builder().token(token).post_init(post_init).build()
    app.bot_data["db"] = DB(os.environ.get("DB_PATH", "mood.db"))
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("stop", cmd_stop))
    app.add_handler(CommandHandler("settings", cmd_settings))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("settime", cmd_settime))
    app.add_handler(CommandHandler("frequency", cmd_frequency))
    app.add_handler(CommandHandler("timezone", cmd_timezone))
    app.add_handler(CommandHandler("week", _period_cmd(7, "Last 7 days")))
    app.add_handler(CommandHandler("month", _period_cmd(30, "Last 30 days")))
    app.add_handler(CommandHandler("year", _period_cmd(365, "Last 365 days")))
    app.add_handler(CallbackQueryHandler(on_answer, pattern=r"^m:"))
    # Anything else is deliberately ignored: this is not a chat bot.
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
