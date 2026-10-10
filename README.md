# Mood tracker bot

A Telegram bot that asks one question, *How are you feeling now?*, 1 to 4 times a day,
with three answers: 😊 Happy, 😐 Normal, 😣 Unpleasant. Answers go into a Google Sheet,
and you get weekly and monthly reports with a chart. It does not chat.

It runs on Google's servers as an Apps Script inside the Sheet: no server, no hosting, free.

## Setup (about 5 minutes, once)

1. **Get a bot token.** In Telegram, open @BotFather. If you already have a bot, send `/revoke`
   and pick it to get a fresh token. Otherwise send `/newbot`. Keep the token handy.
2. **Open the Google Sheet** you want to use (any blank one works).
3. In the Sheet: **Extensions → Apps Script**. Delete whatever is in the editor.
4. Open [`apps-script/Code.js`](apps-script/Code.js), click the **copy** button (top right of the file),
   paste it into the Apps Script editor, and click the 💾 **Save** icon.
5. Go back to the Sheet tab and **reload the page**. A **🙂 Mood bot** menu appears next to *Help*.
6. Click **🙂 Mood bot → Connect Telegram bot**. Google asks for permission the first time:
   choose your account → *Advanced* → *Go to (project name)* → *Allow*. (Google shows a warning
   because you wrote the script yourself and it isn't "verified". That's expected.)
   Click the menu item again, paste the token, OK.
7. In Telegram, open your bot and send `/start`. Tap **⚙️ Settings → 🌍 Timezone** and pick yours.

Done. You can close everything; it keeps running.

## Using it

Everything is buttons. Below the message box:

- **📊 Week, 📅 Month, 📈 Year**: a chart plus stats for the last 7, 30 or 365 days.
- **⚙️ Settings**: check-ins per day (1 to 4), first and last check-in time, timezone, pause/resume.

Check-ins are spread evenly between the first and last time. Default: twice a day, 09:00 and 21:00.
Weekly report arrives on Sunday, 30 minutes after the last check-in; monthly report on the 1st.

Reports show % of each mood, a mood score (happy +1, normal 0, unpleasant −1, averaged),
how many check-ins you answered, change vs the previous period, mood by time of day,
and best/toughest weekday once there are two weeks of data. Every check-in is also a row
in the **Mood log** tab of the Sheet.

Typed commands (`/settime 08:30 22:00`, `/timezone Asia/Tokyo`) still work for times or
timezones the buttons don't list. Only the first Telegram account to send `/start` can use the bot.

## Updating the code

Open the Sheet → Extensions → Apps Script, select all, paste the new `Code.js`, Save.
No need to reconnect; within a minute the bot confirms it picked up the update.

## Good to know

- The script checks Telegram once a minute, so "Noted" can take up to a minute to appear.
- A check-in that couldn't be sent within 30 minutes of its time is skipped rather than sent late.
- **Mood bot → Disconnect** stops it. Your data stays in the sheet.

## Tests

The script's logic is tested against simulated Google services:

```bash
node apps-script/test/sim.test.js
```
