import http from 'http';
import { CONFIG } from './config.js';
import * as db from './db.js';
import { bot } from './bot.js';
import * as manager from './manager.js';

/**
 * Native lightweight HTTP server to satisfy Render's port-binding requirement.
 * Render requires web services to listen on the specified $PORT, 
 * otherwise the deployment will fail health checks.
 */
function startWebPortListener() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      
      let botSummary = [];
      try {
        const bots = await db.getBots();
        botSummary = bots.map(b => ({ name: b.name, status: b.status, isActive: b.isActive }));
      } catch (err) {
        botSummary = `DB Error: ${err.message}`;
      }

      res.end(JSON.stringify({
        status: 'UP',
        timestamp: new Date().toISOString(),
        service: 'Master Bot Controller',
        bots: botSummary
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(CONFIG.PORT, () => {
    console.log(`Render Port Listener active on port ${CONFIG.PORT}`);
  });
}

/**
 * Lifecycle recovery.
 * Fetches all bots that are marked active (isActive = true)
 * and automatically spins them up. Essential for surviving Render restarts!
 */
async function restoreActiveBots() {
  console.log('Checking database for active bots to restore...');
  try {
    const bots = await db.getBots();
    const activeBots = bots.filter(b => b.isActive);
    
    if (activeBots.length === 0) {
      console.log('No active bots to restore.');
      return;
    }

    console.log(`Restoring ${activeBots.length} active bot(s)...`);
    for (const botData of activeBots) {
      console.log(`Auto-starting bot: ${botData.name}`);
      try {
        // Mark status as 'stopped' initially in case it was 'running' but process doesn't exist
        await db.updateBot(botData.id, { status: 'stopped' });
        // Start process
        await manager.startBot(botData);
        console.log(`Successfully restored bot: ${botData.name}`);
      } catch (err) {
        console.error(`Failed to restore bot ${botData.name}:`, err);
        await db.updateBot(botData.id, { status: 'error' });
      }
    }
  } catch (err) {
    console.error('Error during lifecycle restore process:', err);
  }
}

async function main() {
  console.log('Starting Master Bot Controller...');
  
  // 1. Connect to Database
  await db.connectDB();

  // 2. Start Render HTTP healthcheck listener
  startWebPortListener();

  // 3. Start the Master Telegram Bot
  bot.start({
    onStart: (botInfo) => {
      console.log(`Master Bot @${botInfo.username} started successfully!`);
    }
  });

  // 4. Restore active child bots from database (async)
  await restoreActiveBots();
}

// Handle termination gracefully
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Stopping child processes...');
  // Retrieve bots and stop their processes cleanly
  try {
    const bots = await db.getBots();
    for (const b of bots) {
      if (b.status === 'running') {
        console.log(`Stopping child bot process: ${b.name}`);
        await manager.stopBot(b.id);
      }
    }
  } catch (e) {}
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal crash in main entrypoint:', err);
  process.exit(1);
});
