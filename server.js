require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { OAuth2Client } = require("google-auth-library");
const path = require("path");

const app = express();
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

app.use(cors());
app.use(express.json());

// ================= Serve static frontend =================
app.use(express.static(path.join(__dirname)));

// Serve index.html at root
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// SPA catch-all (for routing)
app.get("*", (req, res) => {
    // Prevent API paths from being sent here
    if (req.path.startsWith("/api")) return res.status(404).send("Not Found");
    res.sendFile(path.join(__dirname, "index.html"));
});

// ================= DATABASE IN MEMORY =================
const users = {};          // userId -> user info
const sessions = {};       // sessionToken -> { user, fbToken, cookie }
const jobs = {};           // jobId -> { logs, progress, done }
const paymentRequests = {}; // requestId -> { user, plan, status, reference }

// ================= AUTH MIDDLEWARE =================
function auth(req, res, next) {
    const token = req.headers.authorization;
    if (!token || !sessions[token]) return res.status(401).json({ error: "Unauthorized" });
    req.session = sessions[token];
    next();
}

// ================= PREMIUM CHECK =================
function requirePremium(req, res, next) {
    const user = req.session.user;
    if (!user) return res.status(401).json({ error: "No user" });
    if (user.plan === "FREE") return res.status(403).json({ error: "Upgrade to premium" });
    if (user.expiresAt && Date.now() > user.expiresAt) {
        user.plan = "FREE";
        return res.status(403).json({ error: "Subscription expired" });
    }
    next();
}

// ================= GOOGLE LOGIN =================
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
            name: payload.name,
            plan: "FREE",
            expiresAt: null
        };

        users[user.id] = user;

        const sessionToken = uuidv4();
        sessions[sessionToken] = { user };

        res.json({ token: sessionToken, user });
    } catch {
        res.status(400).json({ error: "Google login failed" });
    }
});

// ================= FACEBOOK COOKIE LOGIN =================
app.post("/api/login", async (req, res) => {
    try {
        const { cookie } = req.body;

        const response = await axios.get(
            "https://business.facebook.com/business_locations",
            { headers: { "user-agent": "Mozilla/5.0", cookie } }
        );

        const match = response.data.match(/(EAAG\w+)/);
        if (!match) throw new Error("Token not found");

        const fbToken = match[1];

        const sessionToken = uuidv4();
        sessions[sessionToken] = {
            cookie,
            fbToken,
            user: { id: uuidv4(), plan: "FREE", expiresAt: null }
        };

        res.json({ token: sessionToken });
    } catch {
        res.status(400).json({ error: "Invalid cookie" });
    }
});

// ================= GET USER INFO =================
app.get("/api/user", auth, async (req, res) => {
    try {
        const { fbToken, cookie } = req.session;
        if (!fbToken) return res.json(req.session.user); // Google login

        const response = await axios.get(
            `https://b-graph.facebook.com/me?fields=name,id&access_token=${fbToken}`,
            { headers: { cookie } }
        );

        res.json(response.data);
    } catch {
        res.status(400).json({ error: "Failed to fetch user" });
    }
});

// ================= START SHARE =================
app.post("/api/share", auth, requirePremium, (req, res) => {
    const { link, amount, delay } = req.body;

    const jobId = uuidv4();
    jobs[jobId] = { logs: [], progress: 0, done: false };

    runShare(jobId, req.session, link, amount, delay);

    res.json({ jobId });
});

// ================= SHARE ENGINE =================
async function runShare(jobId, session, link, amount, delay) {
    const { fbToken, cookie } = session;

    for (let i = 1; i <= amount; i++) {
        try {
            const r = await axios.post(
                "https://b-graph.facebook.com/v13.0/me/feed",
                null,
                { params: { link, published: 0, access_token: fbToken }, headers: { cookie } }
            );

            jobs[jobId].logs.push(`[${i}] SUCCESS → ${r.data.id}`);
        } catch {
            jobs[jobId].logs.push(`[${i}] FAILED`);
            jobs[jobId].done = true;
            return;
        }

        jobs[jobId].progress = Math.floor((i / amount) * 100);
        await new Promise(r => setTimeout(r, delay * 1000));
    }

    jobs[jobId].done = true;
}

// ================= SSE LIVE LOGS =================
app.get("/api/stream/:jobId", (req, res) => {
    const jobId = req.params.jobId;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let last = 0;

    const interval = setInterval(() => {
        const job = jobs[jobId];
        if (!job) return;

        const logs = job.logs.slice(last);
        logs.forEach(l => res.write(`data: ${l}\n\n`));
        last = job.logs.length;

        res.write(`data: PROGRESS:${job.progress}\n\n`);

        if (job.done) {
            res.write(`data: DONE\n\n`);
            clearInterval(interval);
            res.end();
        }
    }, 1000);

    req.on("close", () => clearInterval(interval));
});

// ================= PREMIUM REQUEST =================
app.post("/api/premium/request", auth, (req, res) => {
    const { plan, reference } = req.body;
    const id = uuidv4();

    paymentRequests[id] = {
        id,
        user: req.session.user,
        plan,
        reference,
        status: "PENDING"
    };

    res.json({ message: "Request sent" });
});

// ================= ADMIN APPROVE =================
app.post("/api/admin/approve", (req, res) => {
    const { requestId } = req.body;

    const reqPay = paymentRequests[requestId];
    if (!reqPay) return res.status(404).json({ error: "Not found" });

    const user = reqPay.user;

    if (reqPay.plan === "WEEKLY") {
        user.expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    }

    user.plan = reqPay.plan;
    reqPay.status = "APPROVED";

    res.json({ success: true });
});

// ================= PREMIUM STATUS =================
app.get("/api/premium/status", auth, (req, res) => {
    res.json(req.session.user);
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
