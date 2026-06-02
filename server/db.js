// FixIt — PostgreSQL data layer (pg)
// Migrated from the original SQLite schema. Same tables, Postgres dialect.
import pg from 'pg';

const { Pool } = pg;

// Default to a local Postgres named "fixit" owned by the current OS user
// (Homebrew Postgres convention). Override with DATABASE_URL in production.
const connectionString =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.USER || 'postgres'}@localhost:5432/fixit`;

// Managed providers (Railway/Render/Neon/Supabase) require SSL; local does not.
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
export const pool = new Pool({
  connectionString,
  ssl: !isLocal && process.env.PGSSL !== 'disable'
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  console.error('[DB] idle client error:', err.message);
});

// Query helpers ----------------------------------------------------------------
export const query = (text, params) => pool.query(text, params);
export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}
export async function all(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

// Schema + seed (idempotent) ---------------------------------------------------
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
        id          SERIAL PRIMARY KEY,
        uuid        UUID UNIQUE DEFAULT gen_random_uuid(),
        email       TEXT UNIQUE NOT NULL,
        phone       TEXT,
        first_name  TEXT NOT NULL,
        last_name   TEXT NOT NULL,
        role        TEXT NOT NULL CHECK(role IN ('homeowner','contractor','admin')),
        password_hash TEXT,
        created_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS contractors (
        id              SERIAL PRIMARY KEY,
        owner_user_id   INTEGER REFERENCES users(id),
        business_name   TEXT NOT NULL,
        avatar          TEXT NOT NULL,
        specialties     TEXT NOT NULL,
        base_price      REAL DEFAULT 150,
        lat             REAL NOT NULL,
        lng             REAL NOT NULL,
        service_miles   REAL DEFAULT 10,
        verified        INTEGER DEFAULT 0,
        licensed        INTEGER DEFAULT 0,
        rating          REAL DEFAULT 4.5,
        review_count    INTEGER DEFAULT 0,
        jobs_done       INTEGER DEFAULT 0,
        status          TEXT DEFAULT 'available',
        stripe_account  TEXT,
        created_at      TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS bookings (
        id              SERIAL PRIMARY KEY,
        homeowner_id    INTEGER REFERENCES users(id),
        contractor_id   INTEGER REFERENCES contractors(id),
        category        TEXT,
        description     TEXT,
        photo_url       TEXT,
        est_price       REAL,
        final_price     REAL,
        status          TEXT DEFAULT 'pending',
        stripe_intent   TEXT,
        scheduled_at    TIMESTAMPTZ,
        paid_at         TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS chat_rooms (
        id              SERIAL PRIMARY KEY,
        booking_id      INTEGER REFERENCES bookings(id),
        homeowner_id    INTEGER REFERENCES users(id),
        contractor_id   INTEGER REFERENCES users(id),
        created_at      TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS messages (
        id              SERIAL PRIMARY KEY,
        room_id         INTEGER REFERENCES chat_rooms(id),
        sender_id       INTEGER REFERENCES users(id),
        text            TEXT,
        msg_type        TEXT DEFAULT 'text',
        read_at         TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS push_subs (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER REFERENCES users(id),
        endpoint    TEXT UNIQUE,
        p256dh      TEXT,
        auth        TEXT,
        created_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS reviews (
        id              SERIAL PRIMARY KEY,
        booking_id      INTEGER REFERENCES bookings(id),
        contractor_id   INTEGER REFERENCES contractors(id),
        homeowner_id    INTEGER REFERENCES users(id),
        rating          INTEGER,
        comment         TEXT,
        created_at      TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Seed users + contractors (idempotent)
  await pool.query(`
    INSERT INTO users (id,email,first_name,last_name,role)
    VALUES
      (1,'mario@mp.com','Mario','Martinez','contractor'),
      (2,'bob@br.com','Bob','Ridge','contractor'),
      (3,'quinn@qf.com','Quinn','Fix','contractor'),
      (4,'alex@home.com','Alex','Johnson','homeowner')
    ON CONFLICT (id) DO NOTHING;
  `);

  await pool.query(`
    INSERT INTO contractors (id,owner_user_id,business_name,avatar,specialties,base_price,lat,lng,verified,licensed,rating,review_count,jobs_done,status)
    VALUES
      (1,1,'Martinez Pro Plumbing','MP','["Plumbing","Leak Repair","Water Heater"]',185,34.0522,-118.2437,1,1,4.9,312,47,'available'),
      (2,2,'BlueRidge Electric','BR','["Electrical","Wiring","Panel Upgrade"]',210,34.0560,-118.2510,1,1,4.7,194,31,'busy'),
      (3,3,'QuickFix Handyman','QF','["Drywall","General Repair","Painting"]',140,34.0480,-118.2380,0,0,4.5,87,22,'available')
    ON CONFLICT (id) DO NOTHING;
  `);

  // Advance SERIAL sequences past the explicitly-seeded ids so future inserts
  // (which omit id) don't collide with the seed rows.
  await pool.query(`SELECT setval(pg_get_serial_sequence('users','id'), GREATEST((SELECT MAX(id) FROM users), 1));`);
  await pool.query(`SELECT setval(pg_get_serial_sequence('contractors','id'), GREATEST((SELECT MAX(id) FROM contractors), 1));`);
}
