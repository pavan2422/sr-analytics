# Troubleshooting Guide

## Uploads Fail with "404 Upload session not found"

**Symptoms:**
- Uploading large files fails after initialization.
- Server logs show `[Upload Error] Session ... not found`.
- Error detail mentions `DB_URL=CACHE_LOCAL_SQLITE`.

**Cause:**
You are likely deploying to a **Serverless environment (e.g., Vercel, AWS Lambda)** without a persistent database configuration.

- By default, the app uses **SQLite**.
- If `DATABASE_URL` is not set, it creates a database in `/tmp`.
- On serverless platforms, `/tmp` is **not shared** between requests (Lambda instances).
- The `init` request creates a session in Instance A's `/tmp`.
- The `upload part` request hits Instance B's `/tmp` (which is empty), resulting in a 404.

**Solution:**

### 1. Configure a Persistent Database
To run this application in production (Vercel/Netlify/AWS), you **must** use an external database.

1.  Provision a **Postgres** or **MySQL** database (e.g., Supabase, Neon, PlanetScale, Vercel Postgres).
2.  Set the environment variable in your deployment settings:
    ```bash
    DATABASE_URL="postgresql://user:password@host:5432/dbname?schema=public"
    ```
3.  Redeploy the application.

### 2. (Alternative) Use a Persistent Volume (Docker/VPS)
If you are deploying via Docker or on a VPS (EC2, DigitalOcean):
- Ensure the `prisma/dev.db` file is in a mounted volume that persists across restarts.
- Set `DATABASE_URL="file:/path/to/mounted/volume/dev.db"`

---

## "Database is locked" Errors

**Symptoms:**
- 503 errors during uploads.
- Logs show `SQLITE_BUSY`.

**Cause:**
SQLite allows only one writer at a time. High concurrency (many upload chunks at once) can lock the file.

**Solution:**
- Switch to **PostgreSQL** or **MySQL** (as above) which handles concurrency much better.
- If sticking with SQLite (local only), reduce chunk concurrency in the client (not currently configurable via env vars, requires code change).
