import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';

const { Pool } = pg;

let pool = null;
let isPostgres = false;
const JSON_DB_DIR = './data';
const JSON_DB_FILE = path.join(JSON_DB_DIR, 'bots.json');
const JSON_SETTINGS_FILE = path.join(JSON_DB_DIR, 'settings.json');

// Ensure JSON DB fallback directory exists
if (!fs.existsSync(JSON_DB_DIR)) {
  fs.mkdirSync(JSON_DB_DIR, { recursive: true });
}
if (!fs.existsSync(JSON_DB_FILE)) {
  fs.writeFileSync(JSON_DB_FILE, JSON.stringify([], null, 2));
}
if (!fs.existsSync(JSON_SETTINGS_FILE)) {
  fs.writeFileSync(JSON_SETTINGS_FILE, JSON.stringify({}, null, 2));
}

export async function connectDB() {
  const dbUri = process.env.DATABASE_URL || CONFIG.MONGODB_URI;

  if (dbUri && (dbUri.startsWith('postgres://') || dbUri.startsWith('postgresql://'))) {
    try {
      console.log('Connecting to PostgreSQL database...');
      pool = new Pool({
        connectionString: dbUri,
        ssl: dbUri.includes('sslmode=require') || !dbUri.includes('localhost')
          ? { rejectUnauthorized: false }
          : false
      });

      // Test connection
      await pool.query('SELECT NOW()');
      console.log('Successfully connected to PostgreSQL.');
      isPostgres = true;

      // Initialize Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bots (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          git_url TEXT NOT NULL,
          env_vars JSONB NOT NULL DEFAULT '{}',
          is_active BOOLEAN NOT NULL DEFAULT FALSE,
          status VARCHAR(50) NOT NULL DEFAULT 'stopped',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS settings (
          key VARCHAR(255) PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('PostgreSQL schema initialized/verified.');
    } catch (err) {
      console.error('Failed to connect to PostgreSQL. Falling back to local JSON database.', err);
      isPostgres = false;
    }
  } else {
    console.log('No SQL/PostgreSQL URL found in environment. Using local JSON database (ephemeral on Render).');
    isPostgres = false;
  }
}

// ---------------- Fallback JSON Helpers ----------------
function readJsonDB() {
  try {
    const data = fs.readFileSync(JSON_DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading JSON DB, returning empty list:', err);
    return [];
  }
}

function writeJsonDB(data) {
  try {
    fs.writeFileSync(JSON_DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error writing to JSON DB:', err);
  }
}

function readJsonSettings() {
  try {
    const data = fs.readFileSync(JSON_SETTINGS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading JSON Settings, returning empty object:', err);
    return {};
  }
}

function writeJsonSettings(data) {
  try {
    fs.writeFileSync(JSON_SETTINGS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error writing to JSON Settings:', err);
  }
}

// ---------------- Database Interface ----------------

function mapFromRow(row) {
  if (!row) return null;
  return {
    id: row.id.toString(),
    name: row.name,
    gitUrl: row.git_url,
    envVars: row.env_vars || {},
    isActive: row.is_active,
    status: row.status,
    createdAt: row.created_at
  };
}

export async function getBots() {
  if (isPostgres) {
    const res = await pool.query('SELECT * FROM bots ORDER BY id ASC');
    return res.rows.map(mapFromRow);
  } else {
    return readJsonDB();
  }
}

export async function getBot(id) {
  if (isPostgres) {
    const parsedId = parseInt(id, 10);
    if (isNaN(parsedId)) return null;
    const res = await pool.query('SELECT * FROM bots WHERE id = $1', [parsedId]);
    return res.rows.length ? mapFromRow(res.rows[0]) : null;
  } else {
    const bots = readJsonDB();
    return bots.find(b => b.id === id) || null;
  }
}

export async function createBot(name, gitUrl) {
  if (isPostgres) {
    const res = await pool.query(
      'INSERT INTO bots (name, git_url, env_vars, is_active, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, gitUrl, JSON.stringify({}), false, 'stopped']
    );
    return mapFromRow(res.rows[0]);
  } else {
    const bots = readJsonDB();
    const newBot = {
      id: Date.now().toString(),
      name,
      gitUrl,
      envVars: {},
      isActive: false,
      status: 'stopped',
      createdAt: new Date().toISOString()
    };
    bots.push(newBot);
    writeJsonDB(bots);
    return newBot;
  }
}

export async function updateBot(id, updates) {
  if (isPostgres) {
    // Dynamically build SQL SET statement based on what updates are provided
    const fields = [];
    const values = [];
    let counter = 1;

    if (updates.name !== undefined) {
      fields.push(`name = $${counter++}`);
      values.push(updates.name);
    }
    if (updates.gitUrl !== undefined) {
      fields.push(`git_url = $${counter++}`);
      values.push(updates.gitUrl);
    }
    if (updates.envVars !== undefined) {
      fields.push(`env_vars = $${counter++}`);
      values.push(JSON.stringify(updates.envVars));
    }
    if (updates.isActive !== undefined) {
      fields.push(`is_active = $${counter++}`);
      values.push(updates.isActive);
    }
    if (updates.status !== undefined) {
      fields.push(`status = $${counter++}`);
      values.push(updates.status);
    }

    if (fields.length === 0) {
      return getBot(id);
    }

    const parsedId = parseInt(id, 10);
    if (isNaN(parsedId)) return null;

    values.push(parsedId);
    const queryStr = `UPDATE bots SET ${fields.join(', ')} WHERE id = $${counter} RETURNING *`;
    const res = await pool.query(queryStr, values);
    return res.rows.length ? mapFromRow(res.rows[0]) : null;
  } else {
    const bots = readJsonDB();
    const idx = bots.findIndex(b => b.id === id);
    if (idx === -1) return null;
    bots[idx] = { ...bots[idx], ...updates };
    writeJsonDB(bots);
    return bots[idx];
  }
}

export async function deleteBot(id) {
  if (isPostgres) {
    const parsedId = parseInt(id, 10);
    if (isNaN(parsedId)) return;
    await pool.query('DELETE FROM bots WHERE id = $1', [parsedId]);
  } else {
    const bots = readJsonDB();
    const filtered = bots.filter(b => b.id !== id);
    writeJsonDB(filtered);
  }
}

// ---------------- Settings Interface ----------------

export async function getSetting(key, defaultValue = null) {
  if (isPostgres) {
    const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (res.rows.length) {
      try { return JSON.parse(res.rows[0].value); } catch(e) { return res.rows[0].value; }
    }
    return defaultValue;
  } else {
    const settings = readJsonSettings();
    return settings[key] !== undefined ? settings[key] : defaultValue;
  }
}

export async function setSetting(key, value) {
  const valStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (isPostgres) {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [key, valStr]
    );
  } else {
    const settings = readJsonSettings();
    settings[key] = value;
    writeJsonSettings(settings);
  }
}
