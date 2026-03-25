require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { OAuth2Client } = require("google-auth-library");

const app = express();
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

app.use(cors());
app.use(express.json());

// In-memory storage (replace with DB in production)
let users = {};
let sessions = {};
let jobs = {};

// =============================
// AUTH: GOOGLE LOGIN
// =============================
app.post("/api/auth/google", async (req, res) => {
    try {
        const { token } = req.body;

        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: process.env.GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();

        const user = {
            id: payload.sub,
            email: payload.email,
            name: payload.name
        };

        users[user.id] = user;

        const sessionToken = uuidv4();
        sessions[sessionToken] = user;

        res.json({ success: true, token: sessionToken, user });

    } catch (err) {
        res.status(400).json({ error: "Google login failed" });
    }
});

// =============================
// COOKIE LOGIN (LIKE PYTHON)
// =============================
app.post("/api/login", async (req, res) => {
    try {
        const { cookie } = req.body;

        const response = await axios.get(
            "https://business.facebook.com/business_locations",
            {
                headers: {
                    "user-agent": "Mozilla/5.0",
                    "cookie": cookie
                }
            }
        );

        const match = response.data.match(/(EAAG\w+)/);
        if (!match) throw new Error("Token not found");

        const token = match[1];

        const sessionToken = uuidv4();
        sessions[sessionToken] = { cookie, token };

        res.json({ success: true, token: sessionToken });

    } catch (err) {
        res.status(400).json({ error: "Invalid cookie" });
    }
});

// =============================
// GET USER INFO
// =============================
app.get("/api/user", async (req, res) => {
    try {
        const auth = req.headers.authorization;
        const session = sessions[auth];

        if (!session) return res.status(401).json({ error: "Unauthorized" });

        const { token, cookie } = session;

        const response = await axios.get(
            `https://b-graph.facebook.com/me?fields=name,id&access_token=${token}`,
            {
                headers: { cookie }
            }
        );

        res.json(response.data);

    } catch (err) {
        res.status(400).json({ error: "Failed to fetch user" });
    }
});

// =============================
// START SHARE JOB
// =============================
app.post("/api/share", (req, res) => {
    const auth = req.headers.authorization;
    const session = sessions[auth];

    if (!session) return res.status(401).json({ error: "Unauthorized" });

    const { link, amount, delay } = req.body;

    const jobId = uuidv4();

    jobs[jobId] = {
        logs: [],
        progress: 0
    };

    runShare(jobId, session, link, amount, delay);

    res.json({ jobId });
});

// =============================
// SHARE FUNCTION (LIKE PYTHON LOOP)
// =============================
async function runShare(jobId, session, link, amount, delay) {
    const { token, cookie } = session;

    for (let i = 1; i <= amount; i++) {
        try {
            const res = await axios.post(
                `https://b-graph.facebook.com/v13.0/me/feed`,
                null,
                {
                    params: {
                        link,
                        published: 0,
                        access_token: token
                    },
                    headers: { cookie }
                }
            );

            jobs[jobId].logs.push(`[${i}] Success: ${res.data.id}`);

        } catch (err) {
            jobs[jobId].logs.push(`[${i}] Failed`);
            break;
        }

        jobs[jobId].progress = Math.floor((i / amount) * 100);

        await new Promise(r => setTimeout(r, delay * 1000));
    }

    jobs[jobId].done = true;
}

// =============================
// SSE STREAM (LIVE TERMINAL)
// =============================
app.get("/api/stream/:jobId", (req, res) => {

    const jobId = req.params.jobId;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let lastIndex = 0;

    const interval = setInterval(() => {
        const job = jobs[jobId];
        if (!job) return;

        // send new logs
        const newLogs = job.logs.slice(lastIndex);
        newLogs.forEach(log => {
            res.write(`data: ${log}\n\n`);
        });

        lastIndex = job.logs.length;

        // send progress
        res.write(`data: PROGRESS:${job.progress}\n\n`);

        if (job.done) {
            res.write(`data: DONE\n\n`);
            clearInterval(interval);
            res.end();
        }

    }, 1000);
});

// =============================
// BASIC EMAIL/PASSWORD (OPTIONAL)
// =============================
app.post("/api/auth/register", (req, res) => {
    const { email, password } = req.body;

    const id = uuidv4();
    users[id] = { id, email, password };

    res.json({ success: true });
});

app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body;

    const user = Object.values(users).find(
        u => u.email === email && u.password === password
    );

    if (!user) return res.status(400).json({ error: "Invalid credentials" });

    const token = uuidv4();
    sessions[token] = user;

    res.json({ token });
});

// =============================
app.listen(process.env.PORT, () => {
    console.log("Server running on port " + process.env.PORT);
});
