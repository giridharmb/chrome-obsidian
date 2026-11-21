// Reminder scheduling. Pure functions, so they can be tested without Chrome.
// A reminder is { url, title, at (ms), repeat: '' | 'daily' | 'weekly' | 'monthly', snooze?: true }.

/** The first occurrence after `now` for a repeating reminder that was due at `at`. */
export function nextTime(at, repeat, now = Date.now()) {
  const d = new Date(at);
  do {
    if (repeat === 'daily') d.setDate(d.getDate() + 1);
    else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
    else d.setMonth(d.getMonth() + 1);
  } while (d.getTime() <= now);
  return d.getTime();
}

/** Splits reminders into those due now and the list to keep; repeating ones move on to their next time. */
export function advance(reminders, now = Date.now()) {
  const due = reminders.filter((r) => r.at <= now);
  const keep = reminders.flatMap((r) => (r.at > now ? [r] : r.repeat ? [{ ...r, at: nextTime(r.at, r.repeat, now) }] : []));
  return { due, keep };
}

/** Adds a reminder, replacing the link's existing one (a snooze and the main reminder are kept apart). */
export function upsert(reminders, r) {
  return [...reminders.filter((x) => !(x.url === r.url && !!x.snooze === !!r.snooze)), r];
}
