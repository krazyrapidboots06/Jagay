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

// ===============================
// MEMORY STORAGE (USE DB IN PROD)
// ===============================
const users = {};
const sessions = {};
const jobs = {};

// ===============================
// HELPER: AUTH MIDDLEWARE
// ===============================
function auth(req, res, next) {
    const token = req.headers.authorization;
    if (!token || !sessions[token]) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    req.session = sessions[token];
    next();
}

// ===============================
// GOOGLE LOGIN
// ===============================
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
        sessions[sessionToken] = { user };

        res.json({ success: true, token: sessionToken, user });

    } catch (err) {
        res.status(400).json({ error: "Google login failed" });
    }
});

// ===============================
// COOKIE LOGIN (PYTHON STYLE)
// ===============================
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

        const fbToken = match[1];

        const sessionToken = uuidv4();
        sessions[sessionToken] = {
            cookie,
            fbToken
        };

        res.json({ success: true, token: sessionToken });

    } catch (err) {
        res.status(400).json({ error: "Invalid cookie" });
    }
});

// ===============================
// GET FACEBOOK USER
// ===============================
app.get("/api/user", auth, async (req, res) => {
    try {
        const { fbToken, cookie } = req.session;

        const response = await axios.get(
            `https://b-graph.facebook.com/me?fields=name,id&access_token=${fbToken}`,
            {
                headers: { cookie }
            }
        );

        res.json(response.data);

    } catch (err) {
        res.status(400).json({ error: "Failed to fetch user" });
    }
});

// ===============================
// START SHARE JOB
// ===============================
app.post("/api/share", auth, (req, res) => {
    const { link, amount, delay } = req.body;

    if (!link || !amount || !delay) {
        return res.status(400).json({ error: "Missing fields" });
    }

    const jobId = uuidv4();

    jobs[jobId] = {
        logs: [],
        progress: 0,
        done: false
    };

    runShare(jobId, req.session, link, amount, delay);

    res.json({ jobId });
});

// ===============================
// SHARE ENGINE (LIKE PYTHON LOOP)
// ===============================
async function runShare(jobId, session, link, amount, delay) {
    const { fbToken, cookie } = session;

    for (let i = 1; i <= amount; i++) {
        try {
            const response = await axios.post(
                `https://b-graph.facebook.com/v13.0/me/feed`,
                null,
                {
                    params: {
                        link,
                        published: 0,
                        access_token: fbToken
                    },
                    headers: { cookie }
                }
            );

            const id = response.data.id || "unknown";

            jobs[jobId].logs.push(`[${i}] SUCCESS → ${id}`);

        } catch (err) {
            jobs[jobId].logs.push(`[${i}] ERROR → Share failed`);
            jobs[jobId].done = true;
            return;
        }

        jobs[jobId].progress = Math.floor((i / amount) * 100);

        await new Promise(r => setTimeout(r, delay * 1000));
    }

    jobs[jobId].done = true;
}

// ===============================
// SSE STREAM (LIVE TERMINAL)
// ===============================
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

        // progress
        res.write(`data: PROGRESS:${job.progress}\n\n`);

        if (job.done) {
            res.write(`data: DONE\n\n`);
            clearInterval(interval);
            res.end();
        }

    }, 1000);

    req.on("close", () => clearInterval(interval));
});

// ===============================
// LOGOUT
// ===============================
app.post("/api/logout", auth, (req, res) => {
    const token = req.headers.authorization;
    delete sessions[token];
    res.json({ success: true });
});

// ===============================
app.listen(process.env.PORT, () => {
    console.log("🚀 Server running on port " + process.env.PORT);
});
