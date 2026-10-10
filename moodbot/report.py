"""Turns check-in rows into a text summary and a chart."""

import io
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from .db import Prompt  # noqa: E402

MOODS = ("happy", "normal", "unpleasant")
EMOJI = {"happy": "😊", "normal": "😐", "unpleasant": "😣"}
LABEL = {"happy": "Happy", "normal": "Normal", "unpleasant": "Unpleasant"}
COLOR = {"happy": "#2e9e5b", "normal": "#9aa3ad", "unpleasant": "#d1495b"}
SCORE = {"happy": 1, "normal": 0, "unpleasant": -1}
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _pct(n: int, total: int) -> float:
    return 100 * n / total if total else 0.0


def _score(moods: list[str]) -> float | None:
    return sum(SCORE[m] for m in moods) / len(moods) if moods else None


def summarize(prompts: list[Prompt], previous: list[Prompt], tz: str, title: str) -> str:
    zone = ZoneInfo(tz)
    answered = [p for p in prompts if p.mood]
    if not answered:
        return f"📊 {title}\n\nNo check-ins answered in this period. Hard to graph a mystery."

    counts = Counter(p.mood for p in answered)
    n = len(answered)
    lines = [f"📊 {title}", ""]
    for m in MOODS:
        lines.append(f"{EMOJI[m]} {LABEL[m]:<10} {_pct(counts[m], n):5.1f}%  ({counts[m]})")

    score = _score([p.mood for p in answered])
    lines += ["", f"Mood score: {score:+.2f}  (scale −1 to +1)"]
    lines.append(f"Answered {n} of {len(prompts)} check-ins ({_pct(n, len(prompts)):.0f}%)")

    prev_answered = [p.mood for p in previous if p.mood]
    if prev_answered:
        prev_happy = _pct(prev_answered.count("happy"), len(prev_answered))
        delta = _pct(counts["happy"], n) - prev_happy
        prev_score = _score(prev_answered)
        lines.append(f"vs previous period: Happy {delta:+.0f} pts, score {score - prev_score:+.2f}")

    # Time of day, only meaningful with more than one slot.
    by_hour: dict[int, list[str]] = defaultdict(list)
    for p in answered:
        by_hour[p.sent_at.astimezone(zone).hour].append(p.mood)
    if len(by_hour) > 1:
        lines += ["", "By time of day:"]
        for h in sorted(by_hour):
            ms = by_hour[h]
            lines.append(f"  ~{h:02d}:00  {_pct(ms.count('happy'), len(ms)):3.0f}% happy, score {_score(ms):+.2f}  (n={len(ms)})")

    # Weekday pattern needs at least two weeks to say anything.
    days = {p.sent_at.astimezone(zone).date() for p in answered}
    if max(days) - min(days) >= timedelta(days=13):
        by_wd: dict[int, list[str]] = defaultdict(list)
        for p in answered:
            by_wd[p.sent_at.astimezone(zone).weekday()].append(p.mood)
        ranked = sorted(by_wd, key=lambda d: _score(by_wd[d]))
        lines += ["", f"Best day: {WEEKDAYS[ranked[-1]]} ({_score(by_wd[ranked[-1]]):+.2f}), "
                      f"toughest: {WEEKDAYS[ranked[0]]} ({_score(by_wd[ranked[0]]):+.2f})"]
    return "\n".join(lines)


def chart(prompts: list[Prompt], tz: str, start: date, end: date, title: str) -> bytes | None:
    """Stacked bars of mood counts per day (<= 31 days) or per week (longer). `end` is exclusive."""
    zone = ZoneInfo(tz)
    answered = [p for p in prompts if p.mood]
    if not answered:
        return None

    weekly = (end - start).days > 31
    if weekly:
        first = start - timedelta(days=start.weekday())
        buckets = [first + timedelta(weeks=i) for i in range(((end - first).days + 6) // 7)]
        key = lambda d: d - timedelta(days=d.weekday())  # noqa: E731
        fmt = "%d %b"
    else:
        buckets = [start + timedelta(days=i) for i in range((end - start).days)]
        key = lambda d: d  # noqa: E731
        fmt = "%a\n%d" if len(buckets) <= 7 else "%d"

    counts = {b: Counter() for b in buckets}
    for p in answered:
        b = key(p.sent_at.astimezone(zone).date())
        if b in counts:
            counts[b][p.mood] += 1

    fig, ax = plt.subplots(figsize=(10, 4.5), dpi=150)
    x = range(len(buckets))
    bottom = [0] * len(buckets)
    for m in MOODS:
        vals = [counts[b][m] for b in buckets]
        ax.bar(x, vals, bottom=bottom, color=COLOR[m], label=LABEL[m], width=0.75, edgecolor="white", linewidth=0.6)
        bottom = [a + v for a, v in zip(bottom, vals)]

    step = max(1, len(buckets) // 16)
    ax.set_xticks(list(x)[::step], [b.strftime(fmt) for b in buckets][::step], fontsize=8)
    ax.yaxis.get_major_locator().set_params(integer=True)
    ax.set_ylabel("check-ins per week" if weekly else "check-ins per day")
    ax.set_title(title, loc="left", fontsize=12, fontweight="bold")
    ax.spines[["top", "right"]].set_visible(False)
    ax.grid(axis="y", alpha=0.25)
    ax.set_axisbelow(True)
    ax.legend(loc="upper left", bbox_to_anchor=(1.0, 1.0), frameon=False)
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png")
    plt.close(fig)
    return buf.getvalue()


def period(tz: str, days: int, now: datetime | None = None) -> tuple[date, date]:
    """The last `days` full local days, plus today. Returns (start, end_exclusive)."""
    today = (now or datetime.now(ZoneInfo(tz))).astimezone(ZoneInfo(tz)).date()
    end = today + timedelta(days=1)
    return end - timedelta(days=days), end


def to_utc_bounds(tz: str, start: date, end: date) -> tuple[datetime, datetime]:
    zone = ZoneInfo(tz)
    utc = ZoneInfo("UTC")
    return (
        datetime.combine(start, datetime.min.time(), zone).astimezone(utc),
        datetime.combine(end, datetime.min.time(), zone).astimezone(utc),
    )
