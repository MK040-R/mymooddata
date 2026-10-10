import random
from datetime import datetime, time, timedelta, timezone

import pytest

from moodbot import report
from moodbot.db import DB
from moodbot.schedule import check_in_times, parse_hhmm


def test_check_in_times_even_spacing():
    s, e = time(9), time(21)
    assert check_in_times(s, e, 1) == [time(9)]
    assert check_in_times(s, e, 2) == [time(9), time(21)]
    assert check_in_times(s, e, 3) == [time(9), time(15), time(21)]
    assert check_in_times(s, e, 4) == [time(9), time(13), time(17), time(21)]


def test_check_in_times_cross_midnight_and_bounds():
    assert check_in_times(time(22), time(2), 3) == [time(22), time(0), time(2)]
    for bad in (0, 5):
        with pytest.raises(ValueError):
            check_in_times(time(9), time(21), bad)
    with pytest.raises(ValueError):
        parse_hhmm("25:00")


def test_answer_once_only(tmp_path):
    db = DB(str(tmp_path / "t.db"))
    now = datetime.now(timezone.utc)
    pid = db.create_prompt(1, now)
    assert db.answer_prompt(pid, 1, "happy", now)
    assert not db.answer_prompt(pid, 1, "unpleasant", now)  # second tap ignored
    assert not db.answer_prompt(pid, 2, "happy", now)       # other chat can't answer
    assert [p.mood for p in db.prompts_between(1, now - timedelta(1), now + timedelta(1))] == ["happy"]


def _fill(db, days, per_day=2):
    rng = random.Random(1)
    end = datetime(2026, 10, 11, tzinfo=timezone.utc)
    for d in range(days):
        for h in (4, 16)[:per_day]:  # 09:30 and 21:30 IST
            ts = end - timedelta(days=d) + timedelta(hours=h)
            pid = db.create_prompt(1, ts)
            if rng.random() < 0.9:
                db.answer_prompt(pid, 1, rng.choices(report.MOODS, (5, 3, 2))[0], ts)


def test_report_text_and_chart(tmp_path):
    db = DB(str(tmp_path / "t.db"))
    _fill(db, 400)
    tz = "Asia/Kolkata"
    now = datetime(2026, 10, 11, 21, 30, tzinfo=timezone.utc)
    for days in (7, 30, 365):
        start, end = report.period(tz, days, now)
        prompts = db.prompts_between(1, *report.to_utc_bounds(tz, start, end))
        prev = db.prompts_between(1, *report.to_utc_bounds(tz, start - (end - start), start))
        text = report.summarize(prompts, prev, tz, f"Last {days} days")
        assert "Happy" in text and "Mood score" in text
        png = report.chart(prompts, tz, start, end, f"Last {days} days")
        assert png[:4] == b"\x89PNG"
        (tmp_path / f"{days}.png").write_bytes(png)


def test_report_empty():
    assert "No check-ins" in report.summarize([], [], "UTC", "x")
    assert report.chart([], "UTC", datetime(2026, 1, 1).date(), datetime(2026, 1, 8).date(), "x") is None
