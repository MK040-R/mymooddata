# Mood tracker bot

A Telegram bot that asks one question, *How are you feeling now?*, 1 to 4 times a day,
with three answers: 😊 Happy, 😐 Normal, 😣 Unpleasant. It stores the taps and sends
stats with a chart. It does not chat.

## What it does

- Check-ins are spread evenly between a first and last time (default 09:00 and 21:00, twice a day).
- Each tap is recorded once against the check-in it answers; a late answer still counts for the original time.
- Weekly report every Sunday, 30 min after the last check-in. Monthly report on the 1st.
- On demand: `/week`, `/month`, `/year` (rolling 7, 30, 365 days).
- Reports: share of each mood, mood score (happy = +1, normal = 0, unpleasant = −1, averaged),
  response rate, change vs the previous period, mood by time of day, best and toughest weekday (2+ weeks of data).

## Commands

| Command | Example | |
|---|---|---|
| `/start` | | Start or resume |
| `/settime` | `/settime 08:30 22:00` | First and last check-in |
| `/frequency` | `/frequency 3` | Check-ins per day, 1 to 4 |
| `/timezone` | `/timezone Asia/Kolkata` | IANA timezone |
| `/settings` | | Show current schedule |
| `/week` `/month` `/year` | | Stats and chart |
| `/stop` | | Pause (data is kept) |

## Run it

The bot must run somewhere that stays on (a small VPS, a Raspberry Pi, Railway, Fly.io).
It uses long polling, so no public URL or webhook is needed.

```bash
cp .env.example .env          # put your token in TELEGRAM_BOT_TOKEN
docker build -t moodbot .
docker run -d --restart unless-stopped --env-file .env -v moodbot-data:/data --name moodbot moodbot
```

Without Docker:

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
set -a; . ./.env; set +a
python -m moodbot
```

Then open the bot in Telegram and send `/start`. It replies with your chat id; put it in
`ALLOWED_CHAT_IDS` and restart so nobody else can use your bot.

Data lives in one SQLite file (`DB_PATH`). Back it up if you care about your history.

## Tests

```bash
pip install pytest && python -m pytest -q
```
