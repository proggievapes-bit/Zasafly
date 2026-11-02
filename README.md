# ZasaFly prototype: Node.js + XAMPP MySQL + Admin panel

This version replaces browser `localStorage` account storage with a MySQL database managed by XAMPP. It includes a student registration/login page and a protected admin panel that records account registrations, successful/failed logins, logouts, and page views.

## Requirements
- Node.js 18+
- XAMPP with MySQL running
- A browser

## 1. Create the database
1. Open XAMPP Control Panel and start **MySQL**.
2. Click **Admin** next to MySQL to open phpMyAdmin (or visit `http://localhost/phpmyadmin`).
3. Select the **Import** tab.
4. Choose `schema.sql` and click **Import**. This creates the `zasafly` database and its tables.

## 2. Configure the app
A ready-made `.env` is included (hidden file in the project root, with a random session secret and a generated admin password). Open it in a text editor to see your admin login, and change anything you like. If it is missing, copy `.env.example` to `.env`.
1. (Optional) Copy `.env.example` to a new file named `.env` in the project root.
2. Update `SESSION_SECRET` to a long random secret.
3. Set `DB_USER` and `DB_PASSWORD` to match your local MySQL configuration. The XAMPP default is often `root` with an empty password on a local development machine.
4. Set a unique `ADMIN_EMAIL` and a strong `ADMIN_PASSWORD` of at least 12 characters. Do not use the example password for anything public.

## 3. Install and start
Open a terminal in this folder and run:

```bash
npm install
npm run dev
```

Visit:
- Student site: `http://localhost:3000`
- Admin panel: `http://localhost:3000/admin.html`
- Health check: `http://localhost:3000/api/health`

The server creates or updates the admin account from `.env` on startup. Use that email/password on the main page's login tab, then click **Admin panel** in the dashboard, or open the admin URL directly after logging in.

## What the admin panel shows
- **Live count of registered students** and a full details table (name, student number, email, institution, registration time, last login, status), with search
- **Real-time updates**: the admin page keeps a Server-Sent Events connection open (`/api/admin/stream`). When a student registers, or an account is disabled/reactivated, the count and table update within a moment and new rows briefly highlight. A "Live" badge shows the connection state. The server also checks the database every 3 seconds while an admin page is open, so rows added or edited directly in phpMyAdmin appear too. If the connection drops, the page reconnects automatically and polls every 5 seconds in the meantime.
- Account totals and recent registration counts
- Activity events, timestamps, and IP addresses
- Failed login attempts
- Disable/reactivate student accounts

## Important prototype/security notes
- This is a local development starter, not yet production-ready.
- User accounts and activity logs are stored in MySQL; passwords are hashed with bcryptjs on the server.
- The built-in Express session MemoryStore is for local testing only. Use a persistent session store (for example, a MySQL-backed store or Redis) for deployment.
- `/api/login` and `/api/register` have a basic in-memory per-IP rate limit (10 attempts per 10 minutes) to slow down brute-force/spam attempts on a single process. This resets on server restart and does not share state across multiple instances — swap it for a shared store (e.g. Redis) if you ever run more than one process.
- Before public launch, add HTTPS, secure cookie settings, CSRF protection as appropriate, a production-grade rate limiter, email verification, password reset, backups, access controls, a privacy notice and a defined activity-log retention policy.
- Do not expose phpMyAdmin or the database to the public internet. Do not store raw passwords.
- Activity tracking is intentionally limited to simple page views and authentication events; it does not record keystrokes or form contents.

## Deploying to the cloud (Render + Aiven free MySQL)
1. **Database:** create a free MySQL service on Aiven. Copy host, port, user, password and database name (usually `defaultdb`), and download the CA certificate.
2. **Tables:** load `schema-cloud.sql` (it omits the `CREATE DATABASE`/`USE` lines):
   `mysql -h HOST -P PORT -u avnadmin -p --ssl-ca=ca.pem defaultdb < schema-cloud.sql`
3. **App:** on Render create a Web Service from your GitHub repo (Build: `npm install`, Start: `npm start`).
4. **Environment variables on Render** (never commit these): `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_CA` (the full certificate text), `SESSION_SECRET` (32+ random characters), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ characters). Do not set `PORT`; Render provides it.
5. Open `https://YOUR-SERVICE.onrender.com`, log in as admin and you are taken to `/admin.html`.

Notes: `/api/version` shows which build is running. The free Render tier sleeps after idle time, and the free Aiven service may power down when unused; both can be woken from their dashboards. Local XAMPP use is unchanged: leave `DB_CA` empty.
