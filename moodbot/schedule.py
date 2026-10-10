"""Pure time maths for check-in slots."""

from datetime import datetime, time, timedelta


def check_in_times(start: time, end: time, per_day: int) -> list[time]:
    """Spread `per_day` check-ins evenly from `start` to `end` inclusive.

    One check-in means just `start`. A window that crosses midnight
    (e.g. 22:00 to 02:00) is allowed.
    """
    if not 1 <= per_day <= 4:
        raise ValueError("per_day must be between 1 and 4")
    if per_day == 1:
        return [start]
    base = datetime(2000, 1, 1)
    s = datetime.combine(base, start)
    e = datetime.combine(base, end)
    if e <= s:
        e += timedelta(days=1)
    step = (e - s) / (per_day - 1)
    return [(s + step * i).time().replace(second=0, microsecond=0) for i in range(per_day)]


def parse_hhmm(s: str) -> time:
    try:
        h, m = s.strip().split(":")
        return time(int(h), int(m))
    except ValueError:
        raise ValueError(f"'{s}' is not a valid HH:MM time") from None
