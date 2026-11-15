export interface DebriefSubmission {
  request_id: string; reviewed: true; note: string; occurred_at: string;
  next_action?: { title: string; due_at: string };
  draft?: { channel: 'email' | 'sms'; subject: string | null; body: string };
}

/** Notes remain local; only explicit labels and dates become suggestions. */
export function proposeDebrief(raw: string) {
  const action = /^(?:next(?: step)?|action|follow[- ]?up)\s*:\s*(.+)$/im.exec(raw)?.[1]?.trim().slice(0, 200) ?? '';
  const day = /^(?:due|date)\s*:\s*(\d{4}-\d{2}-\d{2})\s*$/im.exec(raw)?.[1] ?? '';
  const due = day && validDay(day) ? day : '';
  return { note: raw.trim().slice(0, 2000), action, due,
    subject: 'Following up', body: action ? `Following up on our conversation: ${action}` : 'Thank you for speaking with Coding in Color.' };
}

export function validDay(day: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T12:00:00Z`))
    && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day;
}
