// Messaging layer — sends digital receipts and marketing messages over email/SMS.
//
// Like the payment-gateway layer, this is provider-pluggable. Out of the box it
// runs in SIMULATED mode: messages are validated and "delivered" (logged) so the
// whole CRM/marketing flow works end-to-end with zero external accounts. Wire a
// real provider by setting the env vars below and the same code path goes live.
//
//   Email  → SENDGRID_API_KEY (+ MAIL_FROM)
//   SMS    → TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM
//
// Every send returns { ok, status, error } and never throws, so a bad address in
// a 500-recipient blast can't take down the request.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailConfigured() { return !!process.env.SENDGRID_API_KEY; }
export function smsConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
}

export function messagingMode() {
  const email = emailConfigured() ? 'sendgrid' : 'simulated';
  const sms = smsConfigured() ? 'twilio' : 'simulated';
  return { email, sms };
}

// Validate a recipient address for the channel. Returns null if OK, else a reason.
export function validateRecipient(channel, to) {
  to = String(to || '').trim();
  if (!to) return 'no recipient';
  if (channel === 'email') return EMAIL_RE.test(to) ? null : 'invalid email';
  if (channel === 'sms') {
    const digits = to.replace(/\D/g, '');
    return digits.length >= 7 ? null : 'invalid phone';
  }
  return 'unknown channel';
}

async function sendEmail({ to, subject, body }) {
  if (!emailConfigured()) {
    console.log(`[mail:sim] → ${to} | ${subject}`);
    return { ok: true, status: 'sent' };
  }
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: process.env.MAIL_FROM || 'receipts@tavopoint.com' },
        subject: subject || '(no subject)',
        content: [{ type: 'text/plain', value: body || '' }],
      }),
    });
    if (r.ok) return { ok: true, status: 'sent' };
    return { ok: false, status: 'failed', error: `sendgrid ${r.status}` };
  } catch (e) { return { ok: false, status: 'failed', error: String(e.message || e) }; }
}

async function sendSms({ to, body }) {
  if (!smsConfigured()) {
    console.log(`[sms:sim] → ${to} | ${(body || '').slice(0, 40)}`);
    return { ok: true, status: 'sent' };
  }
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const form = new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body || '' });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (r.ok) return { ok: true, status: 'sent' };
    return { ok: false, status: 'failed', error: `twilio ${r.status}` };
  } catch (e) { return { ok: false, status: 'failed', error: String(e.message || e) }; }
}

// Send one message. channel ∈ {email, sms}. Returns { ok, status, error }.
export async function deliver({ channel, to, subject, body }) {
  const bad = validateRecipient(channel, to);
  if (bad) return { ok: false, status: 'failed', error: bad };
  if (channel === 'email') return sendEmail({ to, subject, body });
  if (channel === 'sms') return sendSms({ to, body });
  return { ok: false, status: 'failed', error: 'unknown channel' };
}
