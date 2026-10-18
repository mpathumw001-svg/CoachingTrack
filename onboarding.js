// onboarding.js - welcomes new people, collects their details, alerts the coach
module.exports = function ({ pool, sendWhatsApp, coachNumber }) {
    const seen = new Set(); // stops double-processing if Meta resends a message

    async function alertCoach(text) {
        console.log('COACH ALERT:', text); // always visible in Render logs
        try { await sendWhatsApp(coachNumber, text); }
        catch (e) { console.error('Coach alert failed:', e.message); }
    }

    // City and country -> timezone name, using Gemini
    async function placeToTimezone(place) {
        try {
            const r = await fetch(
                'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: `Give the IANA timezone name (like Asia/Colombo) for: "${place}". Return only the name. If unclear, return UNKNOWN.` }] }]
                    })
                }
            );
            const j = await r.json();
            const tz = j.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (!tz || tz === 'UNKNOWN') return null;
            new Intl.DateTimeFormat('en', { timeZone: tz }); // throws if invalid
            return tz;
        } catch { return null; }
    }

    // "6:30 am", "6.30 pm", "18:00" -> "18:00"
    function parseTime(input) {
        const s = input.toLowerCase().replace(/a\.?m\.?/, 'am').replace(/p\.?m\.?/, 'pm').trim().replace(/\.$/, '');
        const m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/);
        if (!m) return null;
        let h = +m[1]; const min = +(m[2] || 0);
        if (m[3] === 'pm' && h < 12) h += 12;
        if (m[3] === 'am' && h === 12) h = 0;
        if (h > 23 || min > 59) return null;
        return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    }

    // Called when the sender has NO active habit yet
    async function handle(from, text, msgId) {
        if (msgId) {
            if (seen.has(msgId)) return;
            seen.add(msgId);
            if (seen.size > 500) seen.clear();
        }
        const phone = '+' + from;
        const t = text.trim();

        if (/^coach\b/i.test(t)) {
            await alertCoach(`🔥 1-on-1 coaching request: ${phone}`);
            await sendWhatsApp(from, 'Thank you. Pathum will message you personally very soon.');
            return;
        }

        const r = await pool.query('SELECT * FROM onboarding WHERE phone_number=$1', [phone]);
        const row = r.rows[0];

        if (!row) {
            if (!/^start\b/i.test(t)) {
                await sendWhatsApp(from, 'Welcome to SovereignLab. Reply START to begin your free 7-day habit starter.');
                return;
            }
            await pool.query(
                `INSERT INTO onboarding (phone_number, step) VALUES ($1, 'name')
                 ON CONFLICT (phone_number) DO UPDATE SET step = 'name'`, [phone]);
            await sendWhatsApp(from, 'Welcome to SovereignLab. I am Pathum’s habit coach. Let’s set up your free 7-day starter. It takes one minute.\n\nFirst, what is your name?');
            return;
        }

        if (row.step === 'name') {
            const name = t.slice(0, 60);
            await pool.query("UPDATE onboarding SET name=$1, step='habit' WHERE phone_number=$2", [name, phone]);
            await sendWhatsApp(from, `Nice to meet you, ${name}.\n\nWhich ONE habit do you want to build? For example: wake up at 5, walk 30 minutes, meditate, or sleep by 10.`);
        } else if (row.step === 'habit') {
            await pool.query("UPDATE onboarding SET habit_name=$1, step='place' WHERE phone_number=$2", [t.slice(0, 120), phone]);
            await sendWhatsApp(from, 'Great choice.\n\nWhich city and country are you in? This is so your reminder arrives at the right local time.');
        } else if (row.step === 'place') {
            const tz = await placeToTimezone(t);
            if (!tz) {
                await sendWhatsApp(from, 'I could not find that place. Please send city and country, for example: Colombo, Sri Lanka.');
                return;
            }
            await pool.query("UPDATE onboarding SET timezone=$1, step='time' WHERE phone_number=$2", [tz, phone]);
            await sendWhatsApp(from, 'Got it.\n\nWhat time should I remind you every day? For example: 6:30 am');
        } else if (row.step === 'time') {
            const hhmm = parseTime(t);
            if (!hhmm) {
                await sendWhatsApp(from, 'Please send the time like this: 6:30 am or 18:30.');
                return;
            }
            const u = await pool.query('SELECT user_id FROM users WHERE phone_number=$1 OR phone_number=$2', [phone, from]);
            let userId = u.rows[0]?.user_id;
            if (userId) {
                await pool.query('UPDATE users SET name=$1, reminder_time=$2, timezone=$3 WHERE user_id=$4',
                    [row.name, hhmm, row.timezone, userId]);
            } else {
                const ins = await pool.query(
                    'INSERT INTO users (phone_number, name, reminder_time, timezone) VALUES ($1,$2,$3,$4) RETURNING user_id',
                    [phone, row.name, hhmm, row.timezone]);
                userId = ins.rows[0].user_id;
            }
            await pool.query("INSERT INTO habits (user_id, status, habit_name) VALUES ($1, 'ACTIVE', $2)", [userId, row.habit_name]);
            await pool.query('DELETE FROM onboarding WHERE phone_number=$1', [phone]);

            await sendWhatsApp(from, `Done, ${row.name}. Your habit: ${row.habit_name}.\n\nEvery day at ${hhmm} (${row.timezone}) I will remind you. When you finish, send a voice note or a short text. After 7 days you get your first progress report.`);
            await alertCoach(`🆕 New member\nName: ${row.name}\nPhone: ${phone}\nHabit: ${row.habit_name}\nReminder: ${hhmm} (${row.timezone})`);
        }
    }

    // Called when the sender already has an active habit. Returns true if the message was a command.
    async function handleActiveUser(from, text, userId) {
        const t = text.trim().toUpperCase();
        if (t === 'START') {
            await sendWhatsApp(from, 'You are already in the program. Keep sending your daily check-ins. Reply COACH if you want 1-on-1 coaching.');
            return true;
        }
        if (t === 'COACH') {
            const n = await pool.query('SELECT name FROM users WHERE user_id=$1', [userId]);
            await alertCoach(`🔥 1-on-1 coaching request: ${n.rows[0]?.name || ''} +${from}`);
            await sendWhatsApp(from, 'Thank you. Pathum will message you personally very soon.');
            return true;
        }
        return false;
    }

    return { handle, handleActiveUser };
};
