const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Neon PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'thesovereignlab123';

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

        if (userQuery.rows.length === 0) {
            console.log('No active user/habit for number:', from);
            return;
        }

        const { user_id, habit_id } = userQuery.rows[0];

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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
