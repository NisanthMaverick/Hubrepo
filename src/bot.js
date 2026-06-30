import { Bot, session, InlineKeyboard, GrammyError } from 'grammy';
import { Menu } from '@grammyjs/menu';
import { CONFIG } from './config.js';
import * as db from './db.js';
import * as manager from './manager.js';
import os from 'os';

// Setup Admin checking
const ADMIN_IDS = process.env.ADMIN_IDS 
  ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim(), 10)) 
  : [];

function isAdmin(ctx) {
  if (ADMIN_IDS.length === 0) return true; // Open if not set
  return ADMIN_IDS.includes(ctx.from?.id);
}

// In-memory wizard/input states
const userStates = new Map();
const activeLogIntervals = new Map();

// Initialize the bot
export const bot = new Bot(CONFIG.TELEGRAM_BOT_TOKEN);

// Send startup notification to admin using the child bot's token
async function sendChildBotNotification(botData, userId) {
  try {
    const envs = botData.envVars instanceof Map ? Object.fromEntries(botData.envVars) : botData.envVars || {};
    const tokenKey = Object.keys(envs).find(k => k.toLowerCase() === 'bot_token' || k.toLowerCase() === 'telegram_bot_token');
    if (!tokenKey) {
      console.log(`No token found in env variables for bot ${botData.name}. Skipping notification.`);
      return;
    }
    const token = envs[tokenKey];
    if (!token) return;

    const tempBot = new Bot(token);
    const messageText = `🤖 *${botData.name}* is successfully restarted from Master Bot!`;
    await tempBot.api.sendMessage(userId, messageText, { parse_mode: 'Markdown' });
    console.log(`Sent startup notification from child bot ${botData.name} to user ${userId}`);
  } catch (e) {
    console.error(`Failed to send child bot startup notification:`, e.message);
  }
}

// --- UI Text Content and Inline Keyboards ---

const startText = `🤖 *Welcome to the Bot Master Control!*\n\n` +
  `I can host and manage multiple Telegram bots on this server by cloning their Github repositories dynamically.\n\n` +
  `Use the inline buttons below to navigate and manage your bots:`;

const helpText = `📖 *How to use the Master Bot:*\n\n` +
  `1️⃣ **Add a Bot**: Click the *➕ Add Bot* button and send your Github repository link.\n` +
  `2️⃣ **Add Env / Config**: Go to *📋 Manage Bots*, select your bot, click *Env Variables*, and click *Set/Paste Env Block* to paste the entire contents of a \`.env\` file.\n` +
  `3️⃣ **Edit Individual Variable**: Click on any variable button in the settings menu to edit its value or delete it.\n` +
  `4️⃣ **Start Bot**: Click *Start* in the manage panel. The Master Bot will install dependencies (\`npm install\`) and launch your bot process.\n\n` +
  `*Important Notes:*\n` +
  `• Child bots **must** run in *polling mode* (not webhook), because Render only exposes one port.\n` +
  `• Keep child bots lightweight to fit in Render's 512MB RAM free tier limit.`;

const startKeyboard = new InlineKeyboard()
  .text('📋 Manage Bots', 'menu:manage')
  .row()
  .text('📊 System Status', 'menu:status')
  .text('ℹ️ Help', 'menu:help');

const helpKeyboard = new InlineKeyboard()
  .text('📋 Manage Bots', 'menu:manage')
  .row()
  .text('⬅️ Back to Home', 'menu:back_start');

// --- Helper Utilities for formatting and editing ---

function getDashboardText(bots) {
  if (bots.length === 0) return '📋 *Bot Management Dashboard*\n\nNo bots registered yet.';
  
  let text = `📋 *Bot Management Dashboard*\n━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `🤖 *Total Bots:* \`${bots.length}\`\n\n`;
  
  for (const b of bots) {
    const statusEmoji = b.status === 'running' ? '🟢' : b.status === 'error' ? '🔴' : '⚪';
    let uptimeStr = '';
    if (b.status === 'running') {
      const uptime = manager.getBotUptime(b.id) || '0s';
      uptimeStr = ` | ⏱️ \`${uptime}\``;
    }
    text += `${statusEmoji} *${b.name}*\n└ Status: ${(b.status || 'stopped').toUpperCase()}${uptimeStr}\n\n`;
  }
  return text.trim();
}

function getBotDetailsText(botData) {
  const envCount = Object.keys(botData.envVars || {}).length;
  const statusEmoji = botData.status === 'running' ? '🟢' : botData.status === 'error' ? '🔴' : '⚪';
  
  let uptimeStr = '';
  if (botData.status === 'running') {
    const uptime = manager.getBotUptime(botData.id);
    if (uptime) {
      uptimeStr = `\n⏱️ *Uptime:* \`${uptime}\``;
    }
  }

  return `🤖 *Bot Dashboard:* \`${botData.name}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ *Status:* ${statusEmoji} ${(botData.status || 'stopped').toUpperCase()}${uptimeStr}\n` +
    `🔗 *Git Repo:* [GitHub Repository](${botData.gitUrl})\n` +
    `⚙️ *Environment Variables:* \`${envCount} configured\`\n` +
    `🚀 *Boot Recovery:* ${botData.isActive ? '✅ Enabled' : '❌ Disabled'}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Select an option below to control or configure this bot instance:`;
}

function getEnvMenuText(botData) {
  let envText = `⚙️ *Environment Settings: ${botData.name}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  const envs = botData.envVars instanceof Map ? Object.fromEntries(botData.envVars) : botData.envVars || {};
  const keys = Object.keys(envs).sort();

  if (keys.length === 0) {
    envText += `⚠️ _No environment variables configured._\n\n` +
      `Your bot might need credentials (like \`BOT_TOKEN\`) to run properly.`;
  } else {
    envText += `Click a variable button below to edit its value individually, or paste a new block using *Set/Paste Env Block*:\n\n`;
    keys.forEach(key => {
      const val = envs[key];
      const isSensitive = key.toLowerCase().includes('token') || key.toLowerCase().includes('password') || key.toLowerCase().includes('url') || key.toLowerCase().includes('uri');
      const redacted = isSensitive 
        ? (val.length > 8 ? `${val.substring(0, 4)}...${val.substring(val.length - 4)}` : '••••••••')
        : val;
      envText += `🔹 \`${key}\` = \`${redacted}\`\n`;
    });
  }
  return envText;
}

async function editMenuText(ctx, text) {
  try {
    await ctx.editMessageText(text, { 
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true }
    });
  } catch (e) {
    // Ignore duplicate text edit error
  }
}

// --- GrammY Menu Layout ---

// 1. Dynamic Bot Env Menu
const envMenu = new Menu('env-menu');

envMenu.dynamic(async (ctx, range) => {
  const botId = ctx.session?.currentBotId;
  if (!botId) return;
  
  const botData = await db.getBot(botId);
  if (!botData) return;

  const envs = botData.envVars instanceof Map ? Object.fromEntries(botData.envVars) : botData.envVars || {};
  const keys = Object.keys(envs).sort();

  // List each environment variable as a button
  keys.forEach((key) => {
    const val = envs[key];
    const displayVal = val.length > 12 ? `${val.substring(0, 8)}...` : val;
    
    range.text(`✏️ ${key}=${displayVal}`, async (ctx) => {
      userStates.delete(ctx.from.id);
      
      const promptMsg = await ctx.reply(
        `✏️ *Editing Variable:* \`${key}\`\n\n` +
        `Current value: \`${val}\`\n\n` +
        `👉 Send the new value to update it, or send \`/delete\` to remove this variable.`,
        { parse_mode: 'Markdown' }
      );
      
      userStates.set(ctx.from.id, { 
        action: 'awaiting_single_env_val', 
        botId, 
        key,
        promptMsgId: promptMsg.message_id,
        menuMsgId: ctx.msg?.message_id
      });
    }).row();
  });
});

// Row for adding/pasting variables
envMenu.text('➕ Set/Paste Env Block', async (ctx) => {
  userStates.delete(ctx.from.id);
  const botId = ctx.session?.currentBotId;
  if (!botId) return ctx.reply('No bot selected.');
  
  const promptMsg = await ctx.reply(
    'Please paste your `.env` file contents or write environment variables in `KEY=VALUE` format (one per line).\n\n' +
    'Example:\n' +
    '```\n' +
    'BOT_TOKEN=8244316028:AAEF...\n' +
    'DATABASE_URL=postgres://...\n' +
    '```\n\n' +
    'Values will be parsed and merged automatically!',
    { parse_mode: 'Markdown' }
  );

  userStates.set(ctx.from.id, { 
    action: 'awaiting_env_block', 
    botId,
    promptMsgId: promptMsg.message_id,
    menuMsgId: ctx.msg?.message_id
  });
}).row()
.text('⬅️ Back to Bot Details', async (ctx) => {
  userStates.delete(ctx.from.id);
  const botId = ctx.session?.currentBotId;
  const botData = await db.getBot(botId);
  if (!botData) return ctx.menu.back();

  const text = getBotDetailsText(botData);
  await ctx.editMessageText(text, { 
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true }
  });
  ctx.menu.nav('bot-control');
});

// 1b. Dynamic Logs Menu (for inline logs viewing)
const logsMenu = new Menu('logs-menu')
  .text('🔄 Refresh Logs', async (ctx) => {
    userStates.delete(ctx.from.id);
    const botId = ctx.session?.currentBotId;
    if (!botId) return ctx.reply('No bot selected.');
    const botData = await db.getBot(botId);
    if (!botData) return;

    try { await ctx.answerCallbackQuery('Logs refreshed!'); } catch (e) {}
    const logs = manager.getBotLogs(botId);
    const displayLogs = logs.length > 3000 ? '...\n' + logs.substring(logs.length - 3000) : logs;
    
    const text = `📋 *Logs for ${botData.name}*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `\`\`\`\n${displayLogs}\n\`\`\``;

    await editMenuText(ctx, text);
    ctx.menu.update();
  })
  .row()
  .text('⬅️ Bot Dashboard', async (ctx) => {
    userStates.delete(ctx.from.id);
    const botId = ctx.session?.currentBotId;
    const botData = await db.getBot(botId);
    if (!botData) return ctx.menu.back();

    const text = getBotDetailsText(botData);
    await editMenuText(ctx, text);
    ctx.menu.nav('bot-control');
  });

// 2. Dynamic Bot Control Menu (for a single bot)
const botControlMenu = new Menu('bot-control')
  .text(
    (ctx) => ctx.session?.botStatus === 'running' ? '⏸️ Stop' : '▶️ Start',
    async (ctx) => {
      userStates.delete(ctx.from.id);
      const botId = ctx.session?.currentBotId;
      if (!botId) return ctx.reply('No bot selected.');

      const botData = await db.getBot(botId);
      if (!botData) return ctx.reply('Bot not found.');

      // Check environment variables BEFORE answering processing to prevent double answers
      if (botData.status !== 'running') {
        const allBots = await db.getBots();
        const runningBotsCount = allBots.filter(b => b.status === 'running').length;
        const currentLimit = await db.getSetting('MAX_CONCURRENT_BOTS', 2);
        if (runningBotsCount >= currentLimit) {
          try { await ctx.answerCallbackQuery(); } catch (e) {}

          const warningText = `⚠️ *Warning: Concurrent Limit Reached!*\n\n` +
            `Your current limit is **${currentLimit}**. If you want to start this bot, you can increase the concurrent limit in settings (Note: increasing this limit may lead to crashing your server!).\n\n` +
            `Otherwise, please stop another bot before starting this one.`;
            
          const limitKeyboard = new InlineKeyboard()
            .text('⚙️ Go to Bot Settings', 'nav_settings_from_limit')
            .row()
            .text('⬅️ Back to Dashboard', 'nav_dashboard_from_limit');

          try { await ctx.menu.close(); } catch (e) {}
          
          await ctx.editMessageText(warningText, {
            parse_mode: 'Markdown',
            reply_markup: limitKeyboard,
            link_preview_options: { is_disabled: true }
          });
          return;
        }

        const envs = botData.envVars instanceof Map ? Object.fromEntries(botData.envVars) : botData.envVars || {};
        const keys = Object.keys(envs);
        const hasToken = keys.some(k => k.toLowerCase().includes('token'));

        if (keys.length === 0 || !hasToken) {
          try {
            await ctx.answerCallbackQuery({
              text: '❌ Please configure environment variables (like BOT_TOKEN) first!',
              show_alert: true
            });
          } catch (e) {}
          return;
        }
      }

      try {
        await ctx.answerCallbackQuery('Processing...');
      } catch (e) {}
      
      if (botData.status === 'running') {
        await editMenuText(ctx, `⏳ Stopping bot: ${botData.name}...`);
        await manager.stopBot(botId);
        ctx.session.botStatus = 'stopped';
        
        // Re-render dashboard
        const updatedBot = await db.getBot(botId);
        const text = getBotDetailsText(updatedBot);
        await editMenuText(ctx, text);
        ctx.menu.update();
      } else {
        // Close menu immediately to remove buttons and prevent re-render
        try { await ctx.menu.close(); } catch (e) {}

        const logsKeyboard = new InlineKeyboard().text('🔙 Stop & Back to Dashboard', `stop_logs_${botId}`);

        await ctx.editMessageText(`⏳ Starting bot: ${botData.name} (Installing dependencies & deploying)...`, {
          parse_mode: 'Markdown',
          reply_markup: logsKeyboard,
          link_preview_options: { is_disabled: true }
        });
        
        let logInterval = null;
        let isCleared = false;
        const userId = ctx.from.id;
        
        // Start log polling interval to show progress
        logInterval = setInterval(async () => {
          if (isCleared) return;
          try {
            const logs = manager.getBotLogs(botId);
            const displayLogs = logs.length > 3000 ? '...\n' + logs.substring(logs.length - 3000) : logs;
            
            const liveText = `⏳ *Deploying and Starting:* \`${botData.name}\`\n` +
              `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
              `*Real-time Logs:*\n` +
              `\`\`\`\n${displayLogs}\n\`\`\``;
              
            await ctx.editMessageText(liveText, {
              parse_mode: 'Markdown',
              reply_markup: logsKeyboard,
              link_preview_options: { is_disabled: true }
            });
          } catch (e) {}
        }, 1500);

        // Store this active log interval so it can be cleared if user clicks Back
        const oldActiveLog = activeLogIntervals.get(userId);
        if (oldActiveLog) {
          clearInterval(oldActiveLog.intervalId);
        }
        activeLogIntervals.set(userId, {
          intervalId: logInterval,
          botId,
          isCleared: false
        });

        try {
          await manager.startBot(botData);
          
          // Check if cancelled in the meantime
          const currentLog = activeLogIntervals.get(userId);
          if (!currentLog || currentLog.isCleared) {
            if (logInterval) clearInterval(logInterval);
            return;
          }

          ctx.session.botStatus = 'running';
          isCleared = true;
          if (logInterval) clearInterval(logInterval);
          activeLogIntervals.delete(userId);
          
          // Send notification via child bot to admin
          sendChildBotNotification(botData, userId).catch(err => console.error(err));
          
          try {
            const logs = manager.getBotLogs(botId);
            const displayLogs = logs.length > 3000 ? '...\n' + logs.substring(logs.length - 3000) : logs;
            const successText = `🟢 *Bot "${botData.name}" Started Successfully!*\n` +
              `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
              `*Final Boot Logs:*\n` +
              `\`\`\`\n${displayLogs}\n\`\`\``;
            await ctx.editMessageText(successText, {
              parse_mode: 'Markdown',
              reply_markup: logsKeyboard,
              link_preview_options: { is_disabled: true }
            });
          } catch (e) {}

          await new Promise(r => setTimeout(r, 2000));
          
          // Check if cancelled/navigated away in the meantime
          if (ctx.session?.currentBotId === botId) {
            const updatedBot = await db.getBot(botId);
            const text = getBotDetailsText(updatedBot);
            await editMenuText(ctx, text);
            ctx.menu.nav('bot-control');
          }
        } catch (err) {
          // Check if cancelled in the meantime
          const currentLog = activeLogIntervals.get(userId);
          if (!currentLog || currentLog.isCleared) {
            if (logInterval) clearInterval(logInterval);
            return;
          }

          isCleared = true;
          if (logInterval) clearInterval(logInterval);
          activeLogIntervals.delete(userId);
          ctx.session.botStatus = 'error';
          
          const errorMsg = `❌ *Startup Failed for ${botData.name}!*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `The process crashed immediately on boot.\n\n` +
            `*Error Traceback:*\n` +
            `\`\`\`\n${err.message}\n\`\`\``;
            
          await ctx.editMessageText(errorMsg, { 
            parse_mode: 'Markdown',
            link_preview_options: { is_disabled: true }
          });
          ctx.menu.nav('bot-control');
        }
      }
    }
  )
  .text('🔄 Restart', async (ctx) => {
    userStates.delete(ctx.from.id);
    const botId = ctx.session?.currentBotId;
    if (!botId) return ctx.reply('No bot selected.');
    const botData = await db.getBot(botId);
    if (!botData) return ctx.reply('Bot not found.');

    try {
      await ctx.answerCallbackQuery('Restarting...');
    } catch (e) {}
    
    // Close menu immediately to remove buttons and prevent re-render
    try { await ctx.menu.close(); } catch (e) {}

    const logsKeyboard = new InlineKeyboard().text('🔙 Stop & Back to Dashboard', `stop_logs_${botId}`);

    await ctx.editMessageText(`⏳ Restarting bot: ${botData.name}...`, {
      parse_mode: 'Markdown',
      reply_markup: logsKeyboard,
      link_preview_options: { is_disabled: true }
    });
    
    let logInterval = null;
    let isCleared = false;
    const userId = ctx.from.id;
    
    try {
      await manager.stopBot(botId);
      
      // Start log polling interval for start phase
      logInterval = setInterval(async () => {
        if (isCleared) return;
        try {
          const logs = manager.getBotLogs(botId);
          const displayLogs = logs.length > 3000 ? '...\n' + logs.substring(logs.length - 3000) : logs;
          
          const liveText = `⏳ *Restarting:* \`${botData.name}\`\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `*Real-time Logs:*\n` +
            `\`\`\`\n${displayLogs}\n\`\`\``;
            
          await ctx.editMessageText(liveText, {
            parse_mode: 'Markdown',
            reply_markup: logsKeyboard,
            link_preview_options: { is_disabled: true }
          });
        } catch (e) {}
      }, 1500);

      // Store this active log interval so it can be cleared if user clicks Back
      const oldActiveLog = activeLogIntervals.get(userId);
      if (oldActiveLog) {
        clearInterval(oldActiveLog.intervalId);
      }
      activeLogIntervals.set(userId, {
        intervalId: logInterval,
        botId,
        isCleared: false
      });

      await manager.startBot(botData);
      
      // Check if cancelled in the meantime
      const currentLog = activeLogIntervals.get(userId);
      if (!currentLog || currentLog.isCleared) {
        if (logInterval) clearInterval(logInterval);
        return;
      }

      ctx.session.botStatus = 'running';
      isCleared = true;
      if (logInterval) clearInterval(logInterval);
      activeLogIntervals.delete(userId);

      // Send notification via child bot to admin
      sendChildBotNotification(botData, userId).catch(err => console.error(err));
      
      try {
        const logs = manager.getBotLogs(botId);
        const displayLogs = logs.length > 3000 ? '...\n' + logs.substring(logs.length - 3000) : logs;
        const successText = `🟢 *Bot "${botData.name}" Restarted Successfully!*\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `*Final Boot Logs:*\n` +
          `\`\`\`\n${displayLogs}\n\`\`\``;
        await ctx.editMessageText(successText, {
          parse_mode: 'Markdown',
          reply_markup: logsKeyboard,
          link_preview_options: { is_disabled: true }
        });
      } catch (e) {}

      await new Promise(r => setTimeout(r, 2000));

      // Check if cancelled/navigated away in the meantime
      if (ctx.session?.currentBotId === botId) {
        const updatedBot = await db.getBot(botId);
        const text = getBotDetailsText(updatedBot);
        await editMenuText(ctx, text);
        ctx.menu.nav('bot-control');
      }
    } catch (err) {
      // Check if cancelled in the meantime
      const currentLog = activeLogIntervals.get(userId);
      if (!currentLog || currentLog.isCleared) {
        if (logInterval) clearInterval(logInterval);
        return;
      }

      isCleared = true;
      if (logInterval) clearInterval(logInterval);
      activeLogIntervals.delete(userId);
      ctx.session.botStatus = 'error';

      const errorMsg = `❌ *Restart Failed for ${botData.name}!*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `The process crashed immediately on boot.\n\n` +
        `*Error Traceback:*\n` +
        `\`\`\`\n${err.message}\n\`\`\``;

      await ctx.editMessageText(errorMsg, { 
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true }
      });
      ctx.menu.nav('bot-control');
    }
  })
  .row()
  .text('⚙️ Env Variables', async (ctx) => {
    userStates.delete(ctx.from.id);
    const botId = ctx.session?.currentBotId;
    if (!botId) return ctx.reply('No bot selected.');
    const botData = await db.getBot(botId);
    if (!botData) return;

    const envText = getEnvMenuText(botData);
    await ctx.editMessageText(envText, { 
      parse_mode: 'Markdown', 
      link_preview_options: { is_disabled: true } 
    });
    ctx.menu.nav('env-menu');
  })
  .text('📋 View Logs', async (ctx) => {
    userStates.delete(ctx.from.id);
    const botId = ctx.session?.currentBotId;
    if (!botId) return ctx.reply('No bot selected.');
    const botData = await db.getBot(botId);
    if (!botData) return;

    try { await ctx.answerCallbackQuery('Loading logs...'); } catch (e) {}
    const logs = manager.getBotLogs(botId);
    const displayLogs = logs.length > 3000 ? '...\n' + logs.substring(logs.length - 3000) : logs;
    
    const text = `📋 *Logs for ${botData.name}*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `\`\`\`\n${displayLogs}\n\`\`\``;

    await ctx.editMessageText(text, { 
      parse_mode: 'Markdown', 
      link_preview_options: { is_disabled: true } 
    });
    ctx.menu.nav('logs-menu');
  })
  .row()
  .text('📥 Update Git Repo', async (ctx) => {
    userStates.delete(ctx.from.id);
    const botId = ctx.session?.currentBotId;
    if (!botId) return ctx.reply('No bot selected.');
    const botData = await db.getBot(botId);
    if (!botData) return ctx.reply('Bot not found.');

    try {
      await ctx.answerCallbackQuery('Updating Git repo...');
    } catch (e) {}
    
    // Close menu immediately to remove buttons and prevent re-render
    try { await ctx.menu.close(); } catch (e) {}

    const logsKeyboard = new InlineKeyboard().text('🔙 Stop & Back to Dashboard', `stop_logs_${botId}`);

    await ctx.editMessageText(`⏳ Updating Git repository for: ${botData.name} (Re-cloning & deploying latest changes)...`, {
      parse_mode: 'Markdown',
      reply_markup: logsKeyboard,
      link_preview_options: { is_disabled: true }
    });
    
    let logInterval = null;
    let isCleared = false;
    const userId = ctx.from.id;
    
    try {
      // Start log polling interval to show progress
      logInterval = setInterval(async () => {
        if (isCleared) return;
        try {
          const logs = manager.getBotLogs(botId);
          const displayLogs = logs.length > 3000 ? '...\n' + logs.substring(logs.length - 3000) : logs;
          
          const liveText = `⏳ *Updating Git Repo:* \`${botData.name}\`\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `*Real-time Logs:*\n` +
            `\`\`\`\n${displayLogs}\n\`\`\``;
            
          await ctx.editMessageText(liveText, {
            parse_mode: 'Markdown',
            reply_markup: logsKeyboard,
            link_preview_options: { is_disabled: true }
          });
        } catch (e) {}
      }, 1500);

      // Store this active log interval so it can be cleared if user clicks Back
      const oldActiveLog = activeLogIntervals.get(userId);
      if (oldActiveLog) {
        clearInterval(oldActiveLog.intervalId);
      }
      activeLogIntervals.set(userId, {
        intervalId: logInterval,
        botId,
        isCleared: false
      });

      await manager.updateBotCode(botData);
      
      // Check if cancelled in the meantime
      const currentLog = activeLogIntervals.get(userId);
      if (!currentLog || currentLog.isCleared) {
        if (logInterval) clearInterval(logInterval);
        return;
      }

      ctx.session.botStatus = 'running';
      isCleared = true;
      if (logInterval) clearInterval(logInterval);
      activeLogIntervals.delete(userId);

      // Send notification via child bot to admin
      sendChildBotNotification(botData, userId).catch(err => console.error(err));
      
      try {
        const logs = manager.getBotLogs(botId);
        const displayLogs = logs.length > 3000 ? '...\n' + logs.substring(logs.length - 3000) : logs;
        const successText = `🟢 *Bot "${botData.name}" Updated & Started Successfully!*\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `*Final Boot Logs:*\n` +
          `\`\`\`\n${displayLogs}\n\`\`\``;
        await ctx.editMessageText(successText, {
          parse_mode: 'Markdown',
          reply_markup: logsKeyboard,
          link_preview_options: { is_disabled: true }
        });
      } catch (e) {}

      await new Promise(r => setTimeout(r, 2000));

      // Check if cancelled/navigated away in the meantime
      if (ctx.session?.currentBotId === botId) {
        const updatedBot = await db.getBot(botId);
        const text = getBotDetailsText(updatedBot);
        await editMenuText(ctx, text);
        ctx.menu.nav('bot-control');
      }
    } catch (err) {
      // Check if cancelled in the meantime
      const currentLog = activeLogIntervals.get(userId);
      if (!currentLog || currentLog.isCleared) {
        if (logInterval) clearInterval(logInterval);
        return;
      }

      isCleared = true;
      if (logInterval) clearInterval(logInterval);
      activeLogIntervals.delete(userId);
      ctx.session.botStatus = 'error';

      const errorMsg = `❌ *Git Update Failed for ${botData.name}!*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `The process crashed immediately on boot.\n\n` +
        `*Error Traceback:*\n` +
        `\`\`\`\n${err.message}\n\`\`\``;

      await ctx.editMessageText(errorMsg, { 
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true }
      });
      ctx.menu.nav('bot-control');
    }
  })
  .text('🔄 Refresh Status', async (ctx) => {
    userStates.delete(ctx.from.id);
    const botId = ctx.session?.currentBotId;
    if (!botId) return ctx.reply('No bot selected.');
    const botData = await db.getBot(botId);
    if (!botData) return;

    try { await ctx.answerCallbackQuery('Status updated!'); } catch (e) {}
    ctx.session.botStatus = botData.status;
    const text = getBotDetailsText(botData);
    await editMenuText(ctx, text);
    ctx.menu.update();
  })
  .text('🔍 Check DB', async (ctx) => {
    userStates.delete(ctx.from.id);
    const botId = ctx.session?.currentBotId;
    if (!botId) return ctx.reply('No bot selected.');
    const botData = await db.getBot(botId);
    if (!botData) return;

    try { await ctx.answerCallbackQuery('Checking database connection...'); } catch (e) {}
    
    const envs = botData.envVars instanceof Map ? Object.fromEntries(botData.envVars) : botData.envVars || {};
    const dbUrl = envs.DATABASE_URL;

    if (!dbUrl) {
      return ctx.reply(`❌ *Database Check for ${botData.name} Failed:*\nNo DATABASE_URL configured for this bot.`, { parse_mode: 'Markdown' });
    }

    try {
      const pgModule = await import('pg');
      const Pool = pgModule.default?.Pool || pgModule.Pool;
      const pool = new Pool({
        connectionString: dbUrl,
        ssl: dbUrl.includes('sslmode=require') || !dbUrl.includes('localhost')
          ? { rejectUnauthorized: false }
          : false,
        connectionTimeoutMillis: 5000
      });

      const client = await pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      await pool.end();

      await ctx.reply(`🟢 *Database Check for ${botData.name}:*\nConnection successful! Database is online.`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`🔴 *Database Check for ${botData.name} Failed:*\n\`\`\`\n${err.message}\n\`\`\``, { parse_mode: 'Markdown' });
    }
  })
  .row()
  .text('🗑️ Delete Bot', async (ctx) => {
    userStates.delete(ctx.from.id);
    const botId = ctx.session?.currentBotId;
    if (!botId) return ctx.reply('No bot selected.');
    const botData = await db.getBot(botId);
    if (!botData) return;

    await editMenuText(ctx, `🗑️ Deleting bot ${botData.name}...`);
    await manager.deleteBotFiles(botId);
    await db.deleteBot(botId);
    await ctx.reply(`Bot ${botData.name} has been deleted.`);
    
    const text = getDashboardText(await db.getBots());
    await ctx.editMessageText(text, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
    ctx.menu.nav('main-menu');
  })
  .text('⬅️ Back to List', async (ctx) => {
    userStates.delete(ctx.from.id);
    const text = getDashboardText(await db.getBots());
    await ctx.editMessageText(text, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
    ctx.menu.nav('main-menu');
  });

botControlMenu.register(envMenu);
botControlMenu.register(logsMenu);

// 3. Settings Menu
export const settingsMenu = new Menu('settings-menu');

settingsMenu.dynamic(async (ctx, range) => {
  const currentLimit = await db.getSetting('MAX_CONCURRENT_BOTS', 2);
  range.text(`🤖 Concurrent Bots Limit: ${currentLimit} (Max 5)`, async (ctx) => {
    userStates.delete(ctx.from.id);
    const promptMsg = await ctx.reply(
      `Please enter the new concurrent bots limit (1-5):`,
      { link_preview_options: { is_disabled: true } }
    );
    userStates.set(ctx.from.id, { 
      action: 'awaiting_concurrency_limit',
      promptMsgId: promptMsg.message_id,
      menuMsgId: ctx.msg?.message_id
    });
  }).row();
});

settingsMenu.text('🔄 Restart All Bots', async (ctx) => {
  userStates.delete(ctx.from.id);
  try { await ctx.answerCallbackQuery('Restarting all active bots...'); } catch (e) {}
  
  const allBots = await db.getBots();
  const runningBots = allBots.filter(b => b.status === 'running');
  
  if (runningBots.length === 0) {
    return ctx.reply('No bots are currently running.');
  }

  await ctx.editMessageText(`⏳ Restarting ${runningBots.length} active bots...\nThis may take a minute.`, {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true }
  });

  for (const b of runningBots) {
    try {
      await manager.stopBot(b.id);
      await manager.startBot(b);
    } catch(e) {
      console.error(`Failed to restart bot ${b.name}:`, e);
    }
  }

  await editMenuText(ctx, `✅ Successfully restarted ${runningBots.length} bots.\n\n⚙️ *Global Master Settings*\n━━━━━━━━━━━━━━━━━━━━━━━━━\nManage your server limits and global actions here.`);
  ctx.menu.update();
}).row();

settingsMenu.text('⬅️ Back to Dashboard', async (ctx) => {
  userStates.delete(ctx.from.id);
  const text = getDashboardText(await db.getBots());
  await editMenuText(ctx, text);
  ctx.menu.nav('main-menu');
});

// 4. Main Menu
export const mainMenu = new Menu('main-menu');

mainMenu.dynamic(async (ctx, range) => {
  const bots = await db.getBots();

  if (bots.length === 0) {
    range.text('No bots registered yet.', () => {}).row();
  } else {
    bots.forEach((b, i) => {
      const statusEmoji = b.status === 'running' ? '🟢' : b.status === 'error' ? '🔴' : '⚪';
      range.text(`${statusEmoji} ${b.name}`, async (ctx) => {
        userStates.delete(ctx.from.id);
        ctx.session.currentBotId = b.id;
        ctx.session.botStatus = b.status;

        const text = getBotDetailsText(b);

        await editMenuText(ctx, text);
        ctx.menu.nav('bot-control');
      });
      if ((i + 1) % 2 === 0) range.row();
    });
    if (bots.length % 2 !== 0) range.row();
  }
});

mainMenu.text('🔄 Refresh', async (ctx) => {
  try { await ctx.answerCallbackQuery('Refreshed!'); } catch (e) {}
  const freshBots = await db.getBots();
  const text = getDashboardText(freshBots);
  await ctx.editMessageText(text, { 
    parse_mode: 'Markdown', 
    reply_markup: mainMenu,
    link_preview_options: { is_disabled: true } 
  });
})
.text('➕ Add Bot', async (ctx) => {
  userStates.delete(ctx.from.id);
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await promptAddBot(ctx);
}).row()
.text('⚙️ Settings', async (ctx) => {
  userStates.delete(ctx.from.id);
  await editMenuText(ctx, '⚙️ *Global Master Settings*\n━━━━━━━━━━━━━━━━━━━━━━━━━\nManage your server limits and global actions here.');
  ctx.menu.nav('settings-menu');
})
.text('⬅️ Back to Home', async (ctx) => {
  userStates.delete(ctx.from.id);
  await ctx.editMessageText(startText, { 
    parse_mode: 'Markdown', 
    reply_markup: startKeyboard,
    link_preview_options: { is_disabled: true } 
  });
});

mainMenu.register(botControlMenu);
mainMenu.register(settingsMenu);

// Initialize Session
bot.use(session({
  initial: () => ({
    currentBotId: null,
    botStatus: 'stopped',
    currentEnvKey: null,
    menuMsgId: null
  })
}));

bot.use(mainMenu);

// --- Bot Commands & hears/callbacks handlers ---

bot.use(async (ctx, next) => {
  if (!isAdmin(ctx)) {
    console.log(`Unauthorized access attempt by ${ctx.from?.username} (ID: ${ctx.from?.id})`);
    return ctx.reply('⚠️ You are not authorized to use this Master Bot.');
  }
  await next();
});

// Command /start
bot.command('start', async (ctx) => {
  userStates.delete(ctx.from.id);
  await ctx.reply(startText, { 
    parse_mode: 'Markdown', 
    reply_markup: startKeyboard,
    link_preview_options: { is_disabled: true } 
  });
});

// Inline Keyboard Callback queries
bot.callbackQuery('menu:manage', async (ctx) => {
  userStates.delete(ctx.from.id);
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const text = getDashboardText(await db.getBots());
  await ctx.editMessageText(text, { 
    parse_mode: 'Markdown', 
    reply_markup: mainMenu,
    link_preview_options: { is_disabled: true } 
  });
});

bot.callbackQuery('menu:addbot', async (ctx) => {
  userStates.delete(ctx.from.id);
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await promptAddBot(ctx);
});

bot.callbackQuery('menu:help', async (ctx) => {
  userStates.delete(ctx.from.id);
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.editMessageText(helpText, { 
    parse_mode: 'Markdown', 
    reply_markup: helpKeyboard,
    link_preview_options: { is_disabled: true } 
  });
});

// Helper function to build system status report text
async function getSystemStatusText() {
  // RAM usage
  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  const usedMemBytes = totalMemBytes - freeMemBytes;
  
  const totalMemMB = Math.round(totalMemBytes / (1024 * 1024));
  const usedMemMB = Math.round(usedMemBytes / (1024 * 1024));
  const memPercent = ((usedMemBytes / totalMemBytes) * 100).toFixed(1);
  
  // CPU and Uptime
  const cpuLoad = os.loadavg()[0].toFixed(2);
  const sysUptimeSecs = os.uptime();
  const sysUptimeDays = Math.floor(sysUptimeSecs / 86400);
  const sysUptimeHrs = Math.floor((sysUptimeSecs % 86400) / 3600);
  const sysUptimeMins = Math.floor((sysUptimeSecs % 3600) / 60);
  
  // Node.js process metrics
  const processMemMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
  const botUptimeSecs = process.uptime();
  const botUptimeHrs = Math.floor(botUptimeSecs / 3600);
  const botUptimeMins = Math.floor((botUptimeSecs % 3600) / 60);
  const botUptimeStr = botUptimeHrs > 0 ? `${botUptimeHrs}h ${botUptimeMins}m` : `${botUptimeMins}m`;

  const bots = await db.getBots();
  const runningBotsCount = bots.filter(b => b.status === 'running').length;

  return `📊 *System Status Dashboard*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🖥️ *Server Resource Usage:*\n` +
    `• *Memory (RAM):* \`${usedMemMB}MB / ${totalMemMB}MB\` (${memPercent}%)\n` +
    `• *Process Memory:* \`${processMemMB}MB\` (Node.js heap)\n` +
    `• *CPU Load (1m):* \`${cpuLoad}\`\n` +
    `• *OS Platform:* \`${os.platform()} (${os.arch()})\`\n` +
    `• *Server Uptime:* \`${sysUptimeDays}d ${sysUptimeHrs}h ${sysUptimeMins}m\`\n\n` +
    `🤖 *Master Controller Uptime:* \`${botUptimeStr}\`\n\n` +
    `🗄️ *Database Configuration:*\n` +
    `• *DB Engine:* \`PostgreSQL (pooled.db.prisma.io)\`\n` +
    `• *Status:* 🟢 Connected & Online\n\n` +
    `📦 *Host Application Summary:*\n` +
    `• *Total Registered Bots:* \`${bots.length}\`\n` +
    `• *Currently Running:* \`🟢 ${runningBotsCount} active\`\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

// Inline keyboard for status page
const statusKeyboard = new InlineKeyboard()
  .text('🔄 Refresh Status', 'menu:status_refresh')
  .text('⬅️ Back to Home', 'menu:back_start');

bot.callbackQuery('menu:status', async (ctx) => {
  userStates.delete(ctx.from.id);
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const statusText = await getSystemStatusText();
  await ctx.editMessageText(statusText, { 
    parse_mode: 'Markdown', 
    reply_markup: statusKeyboard,
    link_preview_options: { is_disabled: true }
  });
});

bot.callbackQuery('menu:status_refresh', async (ctx) => {
  userStates.delete(ctx.from.id);
  try { await ctx.answerCallbackQuery('Status refreshed!'); } catch (e) {}
  const statusText = await getSystemStatusText();
  await ctx.editMessageText(statusText, { 
    parse_mode: 'Markdown', 
    reply_markup: statusKeyboard,
    link_preview_options: { is_disabled: true }
  });
});

bot.callbackQuery('menu:back_start', async (ctx) => {
  userStates.delete(ctx.from.id);
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.editMessageText(startText, { 
    parse_mode: 'Markdown', 
    reply_markup: startKeyboard,
    link_preview_options: { is_disabled: true } 
  });
});

bot.callbackQuery('nav_settings_from_limit', async (ctx) => {
  userStates.delete(ctx.from.id);
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.editMessageText('⚙️ *Global Master Settings*\n━━━━━━━━━━━━━━━━━━━━━━━━━\nManage your server limits and global actions here.', { 
    parse_mode: 'Markdown', 
    reply_markup: settingsMenu,
    link_preview_options: { is_disabled: true } 
  });
});

bot.callbackQuery('nav_dashboard_from_limit', async (ctx) => {
  userStates.delete(ctx.from.id);
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const text = getDashboardText(await db.getBots());
  await ctx.editMessageText(text, { 
    parse_mode: 'Markdown', 
    reply_markup: mainMenu,
    link_preview_options: { is_disabled: true } 
  });
});

bot.callbackQuery(/stop_logs_(\d+)/, async (ctx) => {
  const botId = parseInt(ctx.match[1], 10);
  const userId = ctx.from.id;
  
  const activeLog = activeLogIntervals.get(userId);
  if (activeLog) {
    clearInterval(activeLog.intervalId);
    activeLog.isCleared = true;
    activeLogIntervals.delete(userId);
  }
  
  try { await ctx.answerCallbackQuery('Log stream stopped'); } catch (e) {}
  
  const botData = await db.getBot(botId);
  if (botData) {
    const text = getBotDetailsText(botData);
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true }
    });
    ctx.menu.nav('bot-control');
  }
});

// Standard Command slash fallbacks (if typed)
bot.command('help', async (ctx) => {
  userStates.delete(ctx.from.id);
  await ctx.reply(helpText, { 
    parse_mode: 'Markdown', 
    reply_markup: helpKeyboard,
    link_preview_options: { is_disabled: true } 
  });
});

bot.command('manage', async (ctx) => {
  userStates.delete(ctx.from.id);
  const text = getDashboardText(await db.getBots());
  const msg = await ctx.reply(text, {
    reply_markup: mainMenu,
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true }
  });
  ctx.session.menuMsgId = msg.message_id;
});

bot.command('addbot', async (ctx) => {
  await promptAddBot(ctx);
});

async function promptAddBot(ctx) {
  userStates.delete(ctx.from.id);
  const promptMsg = await ctx.reply('Please send the **GitHub Repository URL** for the bot you want to add.', {
    link_preview_options: { is_disabled: true }
  });
  userStates.set(ctx.from.id, { 
    action: 'awaiting_git_url',
    botId: '',
    promptMsgId: promptMsg.message_id 
  });
}

// --- Text Message Handler (State Machine) ---
bot.on('message:text', async (ctx) => {
  const userId = ctx.from.id;
  const state = userStates.get(userId);

  if (!state) {
    return ctx.reply('Send /start to open the Bot Master Control panel.', {
      reply_markup: startKeyboard,
      link_preview_options: { is_disabled: true }
    });
  }

  const text = ctx.message.text.trim();

  // 1. Handling Git URL input
  if (state.action === 'awaiting_git_url') {
    userStates.delete(userId);
    
    // Clean up input messages
    try { await ctx.deleteMessage(); } catch (e) {}
    try { await ctx.api.deleteMessage(ctx.chat.id, state.promptMsgId); } catch (e) {}

    await handleAddBotUrl(ctx, text);
  } 
  
  // 2. Handling Env Block paste
  else if (state.action === 'awaiting_env_block') {
    userStates.delete(userId);
    const botId = state.botId;
    const botData = await db.getBot(botId);
    
    if (!botData) {
      return ctx.reply('Error: Bot config not found.');
    }

    const lines = text.split('\n');
    const envVars = botData.envVars instanceof Map ? Object.fromEntries(botData.envVars) : botData.envVars || {};
    let addedCount = 0;
    let deletedCount = 0;

    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.substring(0, eqIdx).trim();
        const val = trimmed.substring(eqIdx + 1).trim();
        
        let parsedVal = val;
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          parsedVal = val.substring(1, val.length - 1);
        }

        if (key) {
          if (parsedVal === '') {
            delete envVars[key];
            deletedCount++;
          } else {
            envVars[key] = parsedVal;
            addedCount++;
          }
        }
      }
    });

    const updatedBot = await db.updateBot(botId, { envVars });

    // Clean up chat input messages
    try { await ctx.deleteMessage(); } catch (e) {}
    try { await ctx.api.deleteMessage(ctx.chat.id, state.promptMsgId); } catch (e) {}

    // Edit the existing menu message directly
    const envText = getEnvMenuText(updatedBot);
    try {
      await ctx.api.editMessageText(
        ctx.chat.id, 
        state.menuMsgId, 
        envText, 
        { parse_mode: 'Markdown', reply_markup: envMenu, link_preview_options: { is_disabled: true } }
      );
    } catch (e) {
      const msg = await ctx.reply(envText, { parse_mode: 'Markdown', reply_markup: envMenu, link_preview_options: { is_disabled: true } });
      ctx.session.menuMsgId = msg.message_id;
    }
  } 
  
  // 3. Handling Single Env Value update
  else if (state.action === 'awaiting_single_env_val') {
    userStates.delete(userId);
    const { botId, key } = state;
    const botData = await db.getBot(botId);

    if (!botData) {
      return ctx.reply('Error: Bot config not found.');
    }

    const envVars = botData.envVars instanceof Map ? Object.fromEntries(botData.envVars) : botData.envVars || {};

    if (text.toLowerCase() === '/delete') {
      delete envVars[key];
    } else {
      envVars[key] = text;
    }

    const updatedBot = await db.updateBot(botId, { envVars });

    // Clean up chat input messages
    try { await ctx.deleteMessage(); } catch (e) {}
    try { await ctx.api.deleteMessage(ctx.chat.id, state.promptMsgId); } catch (e) {}

    // Edit the existing menu message directly
    const envText = getEnvMenuText(updatedBot);
    try {
      await ctx.api.editMessageText(
        ctx.chat.id, 
        state.menuMsgId, 
        envText, 
        { parse_mode: 'Markdown', reply_markup: envMenu, link_preview_options: { is_disabled: true } }
      );
    } catch (e) {
      const msg = await ctx.reply(envText, { parse_mode: 'Markdown', reply_markup: envMenu, link_preview_options: { is_disabled: true } });
      ctx.session.menuMsgId = msg.message_id;
    }
  }
  
  // 4. Handling Concurrency Limit setting
  else if (state.action === 'awaiting_concurrency_limit') {
    userStates.delete(userId);
    let newLimit = parseInt(text, 10);
    
    // Clean up chat input messages
    try { await ctx.deleteMessage(); } catch (e) {}
    try { await ctx.api.deleteMessage(ctx.chat.id, state.promptMsgId); } catch (e) {}

    if (isNaN(newLimit) || newLimit < 1) {
      newLimit = 1;
    } else if (newLimit > 5) {
      newLimit = 5;
    }
    
    await db.setSetting('MAX_CONCURRENT_BOTS', newLimit);
    
    const settingsText = '⚙️ *Global Master Settings*\n━━━━━━━━━━━━━━━━━━━━━━━━━\nManage your server limits and global actions here.';
    
    try { await ctx.api.deleteMessage(ctx.chat.id, state.menuMsgId); } catch (e) {}
    await ctx.reply(settingsText, { parse_mode: 'Markdown', reply_markup: settingsMenu, link_preview_options: { is_disabled: true } });
  }
});

// Helper for adding bot
async function handleAddBotUrl(ctx, gitUrl) {
  if (!gitUrl.startsWith('http://') && !gitUrl.startsWith('https://')) {
    return ctx.reply('❌ Invalid URL. Must start with http:// or https://');
  }

  let name = 'unnamed-bot';
  try {
    const parts = gitUrl.replace(/\.git$/, '').split('/');
    name = parts[parts.length - 1];
  } catch (e) {}

  const statusMsg = await ctx.reply(`⏳ Cloning repository for "${name}" to verify access...`, {
    link_preview_options: { is_disabled: true }
  });
  
  try {
    const newBot = await db.createBot(name, gitUrl);
    await manager.cloneBot(newBot);
    
    // Delete status message
    try { await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
    
    const successMsg = await ctx.reply(`🎉 *Bot "${name}" registered successfully!*`, { 
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true }
    });
    setTimeout(() => {
      try { ctx.api.deleteMessage(ctx.chat.id, successMsg.message_id); } catch (e) {}
    }, 4000);

    // Send the dashboard list
    const text = getDashboardText(await db.getBots());
    const msg = await ctx.reply(text, {
      reply_markup: mainMenu,
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true }
    });
    ctx.session.menuMsgId = msg.message_id;
  } catch (err) {
    console.error('Error adding bot:', err);
    try { await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
    await ctx.reply(`❌ Failed to add bot: ${err.message}`);
  }
}

// Global error handler to catch and prevent crashes
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    if (e.description.includes('message is not modified')) {
      console.log('Telegram Warning: Message was not modified (ignored).');
      return;
    }
    if (e.description.includes('query is too old') || e.description.includes('query ID is invalid')) {
      console.log('Telegram Warning: Callback query expired/invalid (ignored).');
      return;
    }
    console.error('Error in request:', e.description);
  } else {
    console.error('Unknown error:', e);
  }
});
