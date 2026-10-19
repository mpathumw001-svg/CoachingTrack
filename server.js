const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Neon PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// New-member onboarding (see onboarding.js)
const onboarding = require('./onboarding')({ pool, sendWhatsApp, coachNumber: '94766094333' });

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
if (!VERIFY_TOKEN) { console.error('VERIFY_TOKEN is missing'); process.exit(1); }

// Health Check Route
app.get('/', (req, res) => {
    res.send('SovereignLab Habit Engine is Live 🚀');
});

// Meta Webhook Verification Route (GET)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
});

// Voice note -> text (Meta download + Gemini transcription)
async function transcribeAudio(mediaId) {
    // 1. Get the download link from Meta
    const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });
    const meta = await metaRes.json();
    if (!meta.url) throw new Error('No media url: ' + JSON.stringify(meta));

    // 2. Download the audio
    const audioRes = await fetch(meta.url, {
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });
    const buffer = Buffer.from(await audioRes.arrayBuffer());
    const mimeType = (meta.mime_type || 'audio/ogg').split(';')[0];

    // 3. Send to Gemini
    const gemRes = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': process.env.GEMINI_API_KEY
            },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: 'Transcribe this voice note exactly. Keep the original language. Return only the transcript.' },
                        { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } }
                    ]
                }]
            })
        }
    );
    const gem = await gemRes.json();
    const text = gem.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini failed: ' + JSON.stringify(gem));
    return text.trim();
}

// Meta Webhook Receiver (POST) - text and voice notes
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // answer Meta immediately

    try {
        const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!msg) return; // status updates etc.

        const from = msg.from; // example: 94766094333
        let text;
        let voiceId = null;

        if (msg.type === 'text') {
            text = msg.text.body;
        } else if (msg.type === 'audio') {
            voiceId = msg.audio.id;
            text = await transcribeAudio(voiceId);
            console.log('Transcript:', text);
        } else {
            console.log('Skipping type:', msg.type);
            return;
        }

        const userQuery = await pool.query(
            `SELECT u.user_id, h.habit_id
             FROM users u
             JOIN habits h ON u.user_id = h.user_id
             WHERE (u.phone_number = $1 OR u.phone_number = $2)
             AND h.status = 'ACTIVE'`,
            [from, '+' + from]
        );

        // New person: hand over to onboarding (only reacts to PERFORM or COACH)
        if (userQuery.rows.length === 0) {
            await onboarding.handle(from, text, msg.id);
            return;
        }

        const { user_id, habit_id } = userQuery.rows[0];

        // Existing member sent a command (PERFORM or COACH): handled, do not log it
        if (await onboarding.handleActiveUser(from, text, user_id)) return;

        const insertQuery = await pool.query(
            `INSERT INTO daily_logs (user_id, habit_id, voice_url, transcript, is_completed, focus_score)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING log_id`,
            [user_id, habit_id, voiceId, text, true, 8]
        );

        console.log('Habit logged! Log ID:', insertQuery.rows[0].log_id);
    } catch (err) {
        console.error('Webhook error:', err);
    }
});

// Main Log Route (Text / Voice Feedback)
app.post('/api/log-habit', async (req, res) => {
    try {
        const { phone_number, feedback_text, voice_url } = req.body;

        if (!phone_number || (!feedback_text && !voice_url)) {
            return res.status(400).json({ status: 'error', message: 'Phone number and Feedback are required' });
        }

        const userQuery = await pool.query(
            `SELECT u.user_id, h.habit_id 
             FROM users u 
             JOIN habits h ON u.user_id = h.user_id 
             WHERE u.phone_number = $1 AND h.status = 'ACTIVE'`,
            [phone_number]
        );

        if (userQuery.rows.length === 0) {
            return res.status(404).json({ status: 'error', message: 'Active user or habit not found' });
        }

        const { user_id, habit_id } = userQuery.rows[0];
        const logText = feedback_text || "Voice log received";

        const insertQuery = await pool.query(
            `INSERT INTO daily_logs (user_id, habit_id, voice_url, transcript, is_completed, focus_score)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING log_id`,
            [user_id, habit_id, voice_url || null, logText, true, 8]
        );

        console.log(`Log saved successfully! Log ID: ${insertQuery.rows[0].log_id}`);

        res.status(200).json({
            status: 'success',
            message: 'Feedback logged to Sovereign Database',
            log_id: insertQuery.rows[0].log_id
        });

    } catch (error) {
        console.error('Database Logging Error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Red-flag call list: people silent for 2+ days
app.get('/red-flags', async (req, res) => {
    if (req.query.key !== VERIFY_TOKEN) return res.sendStatus(403);
    try {
        const result = await pool.query(
            `SELECT u.user_id, u.phone_number,
                    MAX(d.log_date) AS last_log,
                    CURRENT_DATE - MAX(d.log_date) AS days_silent
             FROM users u
             JOIN habits h ON u.user_id = h.user_id AND h.status = 'ACTIVE'
             LEFT JOIN daily_logs d ON d.user_id = u.user_id
             GROUP BY u.user_id, u.phone_number
             HAVING MAX(d.log_date) IS NULL
                 OR CURRENT_DATE - MAX(d.log_date) >= 2`
        );
        res.json({ call_today: result.rows });
    } catch (err) {
        console.error('Red flag error:', err);
        res.sendStatus(500);
    }
});

// Send a WhatsApp text message
async function sendWhatsApp(to, body) {
    const res = await fetch(
        'https://graph.facebook.com/v21.0/1436877596166099/messages',
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to,
                type: 'text',
                text: { body }
            })
        }
    );
    const data = await res.json();
    if (!res.ok) throw new Error('Send failed: ' + JSON.stringify(data));
    return data;
}

// Daily check: WhatsApp the coach the list of silent people
app.get('/daily-check', async (req, res) => {
    if (req.query.key !== VERIFY_TOKEN) return res.sendStatus(403);
    const days = Number(req.query.days ?? 2);
    try {
        const result = await pool.query(
            `SELECT u.phone_number,
                    CURRENT_DATE - MAX(d.log_date) AS days_silent
             FROM users u
             JOIN habits h ON u.user_id = h.user_id AND h.status = 'ACTIVE'
             LEFT JOIN daily_logs d ON d.user_id = u.user_id
             GROUP BY u.phone_number
             HAVING MAX(d.log_date) IS NULL
                 OR CURRENT_DATE - MAX(d.log_date) >= $1`,
            [days]
        );

        if (result.rows.length === 0) {
            return res.json({ sent: false, reason: 'nobody silent' });
        }

        const lines = result.rows.map(r =>
            `${r.phone_number}: ${r.days_silent ?? 'never logged'} days silent`
        );
        await sendWhatsApp('94766094333', '🚩 Call today:\n' + lines.join('\n'));
        res.json({ sent: true, count: result.rows.length });
    } catch (err) {
        console.error('Daily check error:', err);
        res.sendStatus(500);
    }
});

// Send habit reminders to people whose reminder time just arrived
// (uses each person's own timezone; Sri Lanka time if none is saved)
app.get('/send-reminders', async (req, res) => {
    if (req.query.key !== VERIFY_TOKEN) return res.sendStatus(403);
    const force = req.query.force === '1'; // test mode: remind everyone now
    try {
        const result = await pool.query(
            `SELECT u.phone_number
             FROM users u
             JOIN habits h ON u.user_id = h.user_id AND h.status = 'ACTIVE'
             WHERE u.reminder_time IS NOT NULL
               AND ($1 OR (
                    u.reminder_time >  ((NOW() AT TIME ZONE COALESCE(u.timezone, 'Asia/Colombo'))::time - INTERVAL '10 minutes')
                AND u.reminder_time <= ((NOW() AT TIME ZONE COALESCE(u.timezone, 'Asia/Colombo'))::time)
               ))`,
            [force]
        );

        for (const row of result.rows) {
            const to = row.phone_number.replace('+', '');
            await sendWhatsApp(
                to,
                '⏰ Time for your daily habit. Send a text or a voice note when you finish. Your coach is with you.'
            );
        }
        res.json({ reminded: result.rows.length });
    } catch (err) {
        console.error('Reminder error:', err);
        res.sendStatus(500);
    }
});

app.get('/privacy', (req, res) => {
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy - SovereignLab</title>
<style>body{font-family:Arial,sans-serif;max-width:700px;margin:24px auto;padding:0 16px;line-height:1.6}</style>
</head><body>
<h1>Privacy Policy</h1>
<p>Last updated: October 2026</p>
<p>SovereignLab provides a habit coaching service over WhatsApp.</p>
<h2>What we collect</h2>
<p>Your phone number, your name, and the text messages and voice notes you send us about your habit.</p>
<h2>How we use it</h2>
<p>We use this information to remind you, track your habit progress, and give you coaching feedback. Voice notes are converted to text using Google's Gemini service.</p>
<h2>Sharing</h2>
<p>We never sell your data. We share it only with the services needed to run the coaching: WhatsApp (Meta), our database provider, and Google Gemini for transcription.</p>
<h2>Storage and deletion</h2>
<p>Your data is stored in a secured database. To delete your data, message us on WhatsApp at +94 70 514 8962 and we will remove it.</p>
<h2>Contact</h2>
<p>SovereignLab, Sri Lanka. WhatsApp: +94 70 514 8962. Website: sovereignlab.co</p>
</body></html>`);
});


// Send an approved template (works outside the 24-hour window)
async function sendTemplate(to, name) {
    const res = await fetch(
        'https://graph.facebook.com/v21.0/1436877596166099/messages',
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to,
                type: 'template',
                template: {
                    name: 'daily_habit_checkin',
                    language: { code: 'en' },
                    components: [{
                        type: 'body',
                        parameters: [{ type: 'text', parameter_name: 'customer_name', text: name }]
                    }]
                }
            })
        }
    );
    const data = await res.json();
    if (!res.ok) throw new Error('Template failed: ' + JSON.stringify(data));
    return data;
}
app.get('/test-template', async (req, res) => {
    if (req.query.key !== VERIFY_TOKEN) return res.sendStatus(403);
    try {
        const data = await sendTemplate(req.query.to, req.query.name || 'there');
        res.json({ ok: true, data });
    } catch (err) {
        console.error('Template test error:', err);
        res.status(500).send(err.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
