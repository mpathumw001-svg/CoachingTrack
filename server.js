const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Neon PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Health Check Route
app.get('/', (req, res) => {
    res.send('SovereignLab Habit Engine is Live 🚀');
});

// Main Webhook Receiver (Text / Voice Feedback)
app.post('/api/log-habit', async (req, res) => {
    try {
        const { phone_number, feedback_text, voice_url } = req.body;

        if (!phone_number || (!feedback_text && !voice_url)) {
            return res.status(400).json({ status: 'error', message: 'Phone number and Feedback are required' });
        }

        // 1. Fetch User & Active Habit from Postgres
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

        // 2. Insert Log into Postgres Database
        const insertQuery = await pool.query(
            `INSERT INTO daily_logs (user_id, habit_id, voice_url, transcript, is_completed, focus_score)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING log_id`,
            [user_id, habit_id, voice_url || null, logText, true, 8] // Default status completed
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
