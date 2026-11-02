require("dotenv").config();

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();
// Behind a cloud proxy (Render etc.): trust it so req.ip is the real visitor and secure cookies work.
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 3000);

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.warn("WARNING: Set SESSION_SECRET in .env to a long random value before use.");
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "zasafly",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  // Cloud databases (Aiven, TiDB, etc.) require TLS. Set DB_CA to the provider's
  // CA certificate (PEM text; "\n" escapes are accepted). Leave empty for local XAMPP.
  ssl: process.env.DB_CA ? { ca: process.env.DB_CA.replace(/\\n/g, "\n") } : undefined
});

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use((err, req, res, next) => {
  // Malformed JSON bodies would otherwise fall through to Express's default
  // HTML error page, which breaks the frontend's response.json() parsing.
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Malformed request body." });
  }
  next(err);
});
app.use(express.urlencoded({ extended: false }));
app.use(session({
  name: "zasafly.sid",
  secret: process.env.SESSION_SECRET || "unsafe-local-development-secret-change-this",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: "auto", // Secure cookie over HTTPS (cloud), plain over http://localhost.
    maxAge: 1000 * 60 * 60 * 8
  }
}));
// no-cache so the browser always picks up updated pages/scripts after an upgrade.
app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  setHeaders: res => res.setHeader("Cache-Control", "no-store")
}));
app.get("/api/version", (req, res) => {
  res.json({ build: "v2-live-students", folder: __dirname, cwd: process.cwd() });
});

function clientIp(req) {
  // req.ip honours "trust proxy" (set above) so cloud hosts report the real visitor IP.
  return (req.ip || req.socket.remoteAddress || "").replace(/^::ffff:/, "").slice(0, 45);
}

// Minimal in-memory sliding-window limiter for auth endpoints (no extra
// dependency). Good enough for a single-process local prototype; replace
// with a shared store (e.g. Redis) before running more than one instance.
const authAttempts = new Map();
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;
function rateLimitAuth(req, res, next) {
  const key = clientIp(req) || "unknown";
  const now = Date.now();
  const windowStart = now - AUTH_WINDOW_MS;
  const hits = (authAttempts.get(key) || []).filter(t => t > windowStart);
  if (hits.length >= AUTH_MAX_ATTEMPTS) {
    return res.status(429).json({ success: false, message: "Too many attempts. Please wait a few minutes and try again." });
  }
  hits.push(now);
  authAttempts.set(key, hits);
  next();
}
setInterval(() => {
  const windowStart = Date.now() - AUTH_WINDOW_MS;
  for (const [key, hits] of authAttempts) {
    const fresh = hits.filter(t => t > windowStart);
    if (fresh.length) authAttempts.set(key, fresh);
    else authAttempts.delete(key);
  }
}, AUTH_WINDOW_MS).unref();

async function logActivity(req, eventType, description, userId = req.session?.user?.id || null) {
  try {
    await pool.execute(
      "INSERT INTO activity_logs (user_id, event_type, description, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)",
      [userId, eventType, description.slice(0, 255), clientIp(req), (req.get("user-agent") || "").slice(0, 255)]
    );
  } catch (err) {
    console.error("Activity log write failed:", err.message);
  }
}

// ---- Real-time admin updates (Server-Sent Events) ------------------------
// Admin pages hold an open EventSource connection. We push a "students"
// event when the student table changes. Changes made through the app
// (register / enable / disable) notify instantly; a lightweight DB check
// every few seconds also catches edits made directly in phpMyAdmin.
const adminStreams = new Set();
let lastStudentFingerprint = null;
let fingerprintCheckRunning = false;

function broadcastToAdmins(eventName, payload) {
  const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const stream of adminStreams) stream.write(frame);
}

async function checkStudentChanges(force = false) {
  if (fingerprintCheckRunning || (!adminStreams.size && !force)) return;
  fingerprintCheckRunning = true;
  try {
    const [[row]] = await pool.query(`
      SELECT COUNT(*) AS total,
             COALESCE(MAX(id), 0) AS maxId,
             COALESCE(SUM(status = 'disabled'), 0) AS disabled,
             COALESCE(UNIX_TIMESTAMP(MAX(last_login_at)), 0) AS lastLogin
      FROM users WHERE role = 'student'
    `);
    const fingerprint = `${row.total}|${row.maxId}|${row.disabled}|${row.lastLogin}`;
    if (fingerprint !== lastStudentFingerprint) {
      const isFirst = lastStudentFingerprint === null;
      lastStudentFingerprint = fingerprint;
      if (!isFirst || force) broadcastToAdmins("students", { total: Number(row.total), at: Date.now() });
    }
  } catch (err) {
    console.error("Student change check failed:", err.message);
  } finally {
    fingerprintCheckRunning = false;
  }
}
setInterval(() => checkStudentChanges(), 3000).unref();

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ success: false, message: "Please log in." });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ success: false, message: "Please log in." });
  if (req.session.user.role !== "admin") return res.status(403).json({ success: false, message: "Admin access required." });
  next();
}

async function ensureAdminAccount() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  const fullName = process.env.ADMIN_NAME || "ZasaFly Admin";
  if (!email || !password) {
    console.warn("Admin seed skipped. Configure ADMIN_EMAIL and ADMIN_PASSWORD in .env.");
    return;
  }
  if (password.length < 12) {
    console.warn("Admin seed skipped: ADMIN_PASSWORD must be at least 12 characters.");
    return;
  }
  const [rows] = await pool.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
  const passwordHash = await bcrypt.hash(password, 12);
  if (rows.length) {
    await pool.execute(
      "UPDATE users SET full_name = ?, password_hash = ?, role = 'admin', status = 'active' WHERE id = ?",
      [fullName, passwordHash, rows[0].id]
    );
  } else {
    await pool.execute(
      "INSERT INTO users (full_name, email, password_hash, role, status) VALUES (?, ?, ?, 'admin', 'active')",
      [fullName, email, passwordHash]
    );
  }
  console.log(`Admin account ready for ${email}`);
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ success: true, database: "connected" });
  } catch {
    res.status(503).json({ success: false, database: "disconnected", message: "Check XAMPP MySQL and .env settings." });
  }
});

app.post("/api/register", rateLimitAuth, async (req, res) => {
  try {
    const fullName = String(req.body.fullName || "").trim();
    const studentNumber = String(req.body.studentNumber || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const institution = String(req.body.institution || "").trim();
    const password = String(req.body.password || "");

    if (fullName.length < 2 || fullName.length > 120) {
      return res.status(400).json({ success: false, message: "Enter your full name (2–120 characters)." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) {
      return res.status(400).json({ success: false, message: "Enter a valid email address." });
    }
    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({ success: false, message: "Password must be between 8 and 72 characters." });
    }
    // Match the schema's column widths (users.student_number VARCHAR(80),
    // users.institution VARCHAR(190)) so an over-length value fails with a
    // clear message instead of a MySQL "Data too long" error on INSERT.
    if (studentNumber.length > 80) {
      return res.status(400).json({ success: false, message: "Student number must be 80 characters or fewer." });
    }
    if (institution.length > 190) {
      return res.status(400).json({ success: false, message: "Institution name must be 190 characters or fewer." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      "INSERT INTO users (full_name, student_number, email, institution, password_hash) VALUES (?, ?, ?, ?, ?)",
      [fullName, studentNumber || null, email, institution || null, passwordHash]
    );
    await logActivity(req, "user_registered", `New student account registered: ${email}`, result.insertId);
    checkStudentChanges(true); // push to any open admin pages immediately
    // Regenerate the session ID before attaching the new identity (same
    // session-fixation protection already used on the login path).
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ success: false, message: "Account created, but session could not be started. Please log in." });
      req.session.user = {
        id: result.insertId,
        fullName,
        email,
        institution,
        studentNumber,
        role: "student"
      };
      req.session.save(saveErr => {
        if (saveErr) return res.status(500).json({ success: false, message: "Account created, but session could not be started. Please log in." });
        res.status(201).json({ success: true, user: req.session.user });
      });
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "An account with this email already exists. Please log in." });
    }
    console.error("Registration error:", err);
    res.status(500).json({ success: false, message: "Registration failed. Check that XAMPP MySQL is running and the database has been imported." });
  }
});

app.post("/api/login", rateLimitAuth, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!email || !password) return res.status(400).json({ success: false, message: "Enter your email and password." });

  try {
    const [rows] = await pool.execute(
      "SELECT id, full_name, student_number, email, institution, password_hash, role, status FROM users WHERE email = ? LIMIT 1",
      [email]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      await logActivity(req, "login_failed", `Failed login attempt for ${email}`, user?.id || null);
      return res.status(401).json({ success: false, message: "Incorrect email or password." });
    }
    if (user.status !== "active") {
      await logActivity(req, "login_blocked", `Disabled account attempted login: ${email}`, user.id);
      return res.status(403).json({ success: false, message: "This account is disabled. Contact support." });
    }

    await pool.execute("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);
    await logActivity(req, "user_login", `Successful login: ${email}`, user.id);
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ success: false, message: "Could not start a secure session." });
      req.session.user = {
        id: user.id,
        fullName: user.full_name,
        studentNumber: user.student_number || "",
        email: user.email,
        institution: user.institution || "",
        role: user.role
      };
      req.session.save(saveErr => {
        if (saveErr) return res.status(500).json({ success: false, message: "Could not save session." });
        res.json({ success: true, user: req.session.user });
      });
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ success: false, message: "Login failed due to a server/database error." });
  }
});

app.post("/api/logout", requireAuth, async (req, res) => {
  await logActivity(req, "user_logout", `User logged out: ${req.session.user.email}`);
  req.session.destroy(err => {
    res.clearCookie("zasafly.sid");
    if (err) return res.status(500).json({ success: false, message: "Could not log out." });
    res.json({ success: true });
  });
});

app.get("/api/me", (req, res) => {
  res.json({ success: true, user: req.session.user || null });
});

app.post("/api/activity/page-view", async (req, res) => {
  const page = String(req.body.page || "unknown").slice(0, 80);
  await logActivity(req, "page_view", `Page viewed: ${page}`);
  res.status(204).end();
});

// Admin-only endpoints
app.get("/api/admin/summary", requireAdmin, async (req, res) => {
  try {
    const [[userCounts]] = await pool.query(`
      SELECT COUNT(*) AS totalUsers,
             SUM(role = 'student') AS students,
             SUM(role = 'admin') AS admins,
             SUM(status = 'disabled') AS disabledUsers
      FROM users
    `);
    const [[activityCounts]] = await pool.query(`
      SELECT COUNT(*) AS totalEvents,
             SUM(created_at >= NOW() - INTERVAL 24 HOUR) AS eventsLast24h,
             SUM(event_type = 'user_login' AND created_at >= NOW() - INTERVAL 24 HOUR) AS loginsLast24h,
             SUM(event_type = 'user_registered' AND created_at >= NOW() - INTERVAL 7 DAY) AS registrationsLast7d
      FROM activity_logs
    `);
    const [recentActivity] = await pool.query(`
      SELECT a.id, a.event_type AS eventType, a.description, a.ip_address AS ipAddress,
             a.created_at AS createdAt, u.email
      FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC LIMIT 10
    `);
    res.json({ success: true, users: userCounts, activity: activityCounts, recentActivity });
  } catch (err) {
    console.error("Admin summary error:", err);
    res.status(500).json({ success: false, message: "Could not load admin summary." });
  }
});

// Live stream: the admin page connects once and is told when to re-fetch.
app.get("/api/admin/stream", requireAdmin, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  res.write(`event: ready\ndata: {}\n\n`);
  adminStreams.add(res);
  checkStudentChanges(); // seed the fingerprint if this is the first admin
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    adminStreams.delete(res);
  });
});

// Registered students: total count plus full details.
app.get("/api/admin/students", requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().slice(0, 100);
    const like = `%${search}%`;
    const [[{ total }]] = await pool.query("SELECT COUNT(*) AS total FROM users WHERE role = 'student'");
    const [students] = await pool.execute(`
      SELECT id, full_name AS fullName, student_number AS studentNumber, email,
             institution, status, created_at AS createdAt, last_login_at AS lastLoginAt
      FROM users
      WHERE role = 'student'
        AND (? = '' OR full_name LIKE ? OR email LIKE ? OR institution LIKE ? OR student_number LIKE ?)
      ORDER BY created_at DESC, id DESC LIMIT 500
    `, [search, like, like, like, like]);
    res.json({ success: true, total: Number(total), matched: students.length, students });
  } catch (err) {
    console.error("Admin students error:", err);
    res.status(500).json({ success: false, message: "Could not load students." });
  }
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().slice(0, 100);
    const like = `%${search}%`;
    const [users] = await pool.execute(`
      SELECT id, full_name AS fullName, student_number AS studentNumber, email,
             institution, role, status, created_at AS createdAt, last_login_at AS lastLoginAt
      FROM users
      WHERE (? = '' OR full_name LIKE ? OR email LIKE ? OR institution LIKE ?)
      ORDER BY created_at DESC LIMIT 200
    `, [search, like, like, like]);
    res.json({ success: true, users });
  } catch (err) {
    console.error("Admin users error:", err);
    res.status(500).json({ success: false, message: "Could not load users." });
  }
});

app.get("/api/admin/activity", requireAdmin, async (req, res) => {
  try {
    const eventType = String(req.query.type || "").trim().slice(0, 60);
    const [events] = await pool.execute(`
      SELECT a.id, a.event_type AS eventType, a.description, a.ip_address AS ipAddress,
             a.user_agent AS userAgent, a.created_at AS createdAt, u.email
      FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE (? = '' OR a.event_type = ?)
      ORDER BY a.created_at DESC LIMIT 200
    `, [eventType, eventType]);
    res.json({ success: true, events });
  } catch (err) {
    console.error("Admin activity error:", err);
    res.status(500).json({ success: false, message: "Could not load activity logs." });
  }
});

app.patch("/api/admin/users/:id/status", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body.status;
  if (!Number.isInteger(id) || id < 1 || !["active", "disabled"].includes(status)) {
    return res.status(400).json({ success: false, message: "Invalid user or status." });
  }
  if (id === Number(req.session.user.id)) {
    return res.status(400).json({ success: false, message: "You cannot disable your own admin account." });
  }
  try {
    const [result] = await pool.execute("UPDATE users SET status = ? WHERE id = ? AND role = 'student'", [status, id]);
    if (!result.affectedRows) return res.status(404).json({ success: false, message: "Student account not found." });
    await logActivity(req, "admin_user_status_changed", `Admin changed student #${id} status to ${status}`);
    checkStudentChanges(true);
    res.json({ success: true });
  } catch (err) {
    console.error("Update user status error:", err);
    res.status(500).json({ success: false, message: "Could not update account status." });
  }
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

(async () => {
  try {
    await pool.query("SELECT 1");
    console.log("Connected to MySQL database.");
    await ensureAdminAccount();
    app.listen(PORT, () => {
      console.log(`ZasaFly running at http://localhost:${PORT}`);
      console.log(`Live student tracking ENABLED -> open http://localhost:${PORT}/admin.html`);
    });
  } catch (err) {
    console.error("Could not connect to MySQL. Start MySQL in XAMPP and import schema.sql first.");
    console.error(err.message);
    process.exit(1);
  }
})();
