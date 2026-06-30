import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const dbUri = process.env.DATABASE_URL;

async function run() {
  if (!dbUri) {
    console.error('DATABASE_URL is not set in .env');
    process.exit(1);
  }

  const botsJsonFile = './data/bots.json';
  if (!fs.existsSync(botsJsonFile)) {
    console.error('Local bots.json not found. Nothing to restore.');
    process.exit(1);
  }

  let bots = [];
  try {
    bots = JSON.parse(fs.readFileSync(botsJsonFile, 'utf8'));
  } catch (e) {
    console.error('Failed to parse bots.json:', e);
    process.exit(1);
  }

  if (bots.length === 0) {
    console.log('bots.json is empty. Nothing to restore.');
    process.exit(0);
  }

  console.log(`Connecting to database to restore ${bots.length} bots...`);
  const pool = new Pool({
    connectionString: dbUri,
    ssl: dbUri.includes('sslmode=require') || !dbUri.includes('localhost')
      ? { rejectUnauthorized: false }
      : false
  });

  try {
    // 1. Ensure schema exists
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

    // 2. Insert/Upsert bots
    for (const b of bots) {
      const parsedId = parseInt(b.id, 10);
      if (isNaN(parsedId)) {
        console.log(`Skipping bot ${b.name} because ID ${b.id} is not an integer for Postgres.`);
        continue;
      }

      console.log(`Restoring bot: ${b.name} (ID: ${parsedId})...`);
      
      const check = await pool.query('SELECT * FROM bots WHERE id = $1', [parsedId]);
      if (check.rows.length) {
        await pool.query(
          'UPDATE bots SET name = $1, git_url = $2, env_vars = $3 WHERE id = $4',
          [b.name, b.gitUrl, JSON.stringify(b.envVars), parsedId]
        );
        console.log(`Updated existing record for ${b.name}`);
      } else {
        await pool.query(
          'INSERT INTO bots (id, name, git_url, env_vars, is_active, status) VALUES ($1, $2, $3, $4, $5, $6)',
          [parsedId, b.name, b.gitUrl, JSON.stringify(b.envVars), b.isActive, b.status]
        );
        console.log(`Inserted new record for ${b.name}`);
      }
    }

    // 3. Reset Postgres sequence
    await pool.query("SELECT setval(pg_get_serial_sequence('bots', 'id'), COALESCE((SELECT MAX(id) FROM bots), 1), true)");
    console.log('Postgres sequence reset. Restore complete!');

  } catch (err) {
    console.error('Database operation failed:', err);
  } finally {
    await pool.end();
  }
}

run();
