import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const CONFIG = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  MONGODB_URI: process.env.MONGODB_URI,
  DATABASE_URL: process.env.DATABASE_URL,
  BOTS_DIR: process.env.BOTS_DIR || './bots',
  PORT: process.env.PORT || 10000,
  MAX_CONCURRENT_BOTS: parseInt(process.env.MAX_CONCURRENT_BOTS, 10) || 2,
};

// Verify critical variables
if (!CONFIG.TELEGRAM_BOT_TOKEN) {
  console.warn('WARNING: TELEGRAM_BOT_TOKEN is not set in .env! The master bot will not run.');
}
