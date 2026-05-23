import { spawn } from 'cross-spawn';
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';
import * as db from './db.js';
import dotenv from 'dotenv';

// Map of botId -> { process: ChildProcess, logs: string[], restartCount: number, startedAt: number }
const activeBots = new Map();

// Helper to ensure BOTS_DIR exists
function ensureBotsDir() {
  if (!fs.existsSync(CONFIG.BOTS_DIR)) {
    fs.mkdirSync(CONFIG.BOTS_DIR, { recursive: true });
  }
}

/**
 * Get the path where a specific bot is cloned
 */
export function getBotPath(botId) {
  return path.resolve(path.join(CONFIG.BOTS_DIR, botId));
}

/**
 * Loads the child bot's local .env file and strips parent variables to prevent collision
 */
export function getChildEnv(dest) {
  // Inherit standard system environment variables necessary for binaries to execute
  const systemEnv = {};
  const keepKeys = [
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 
    'USERPROFILE', 'HOME', 'LANG', 'LC_ALL', 'COMSPEC',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'COMMONPROGRAMFILES',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE'
  ];
  
  for (const key of keepKeys) {
    if (process.env[key] !== undefined) {
      systemEnv[key] = process.env[key];
    }
    // Also support case-insensitive check for Windows keys
    const lowerKey = key.toLowerCase();
    for (const actualKey of Object.keys(process.env)) {
      if (actualKey.toLowerCase() === lowerKey) {
        systemEnv[actualKey] = process.env[actualKey];
      }
    }
  }

  // Load child's custom environment variables from its .env file
  const envPath = path.join(dest, '.env');
  let childFileEnv = {};
  if (fs.existsSync(envPath)) {
    try {
      const parsed = dotenv.parse(fs.readFileSync(envPath));
      childFileEnv = parsed;
    } catch (e) {
      console.error('Error parsing child .env file:', e);
    }
  }

  // Combine system path with child configuration and suppress process warnings
  const finalEnv = {
    ...systemEnv,
    ...childFileEnv,
    PYTHONWARNINGS: 'ignore',
    NODE_NO_WARNINGS: '1'
  };

  // Safe fallback for SQLAlchemy postgres:// dialect mapping
  if (finalEnv.DATABASE_URL && typeof finalEnv.DATABASE_URL === 'string' && finalEnv.DATABASE_URL.startsWith('postgres://')) {
    finalEnv.DATABASE_URL = finalEnv.DATABASE_URL.replace('postgres://', 'postgresql://');
  }

  return finalEnv;
}

/**
 * Detect runtime language of the repository
 * Returns 'node' | 'python' | 'unknown'
 */
export function detectLanguage(dest) {
  if (!fs.existsSync(dest)) return 'unknown';

  const hasPackageJson = fs.existsSync(path.join(dest, 'package.json'));
  const hasIndexJs = fs.existsSync(path.join(dest, 'index.js'));
  if (hasPackageJson || hasIndexJs) {
    return 'node';
  }

  const hasRequirements = fs.existsSync(path.join(dest, 'requirements.txt'));
  const hasMainPy = fs.existsSync(path.join(dest, 'main.py'));
  const hasBotPy = fs.existsSync(path.join(dest, 'bot.py'));
  
  if (hasRequirements || hasMainPy || hasBotPy) {
    return 'python';
  }

  // Fallback: search for any .py file
  try {
    const files = fs.readdirSync(dest);
    const hasAnyPy = files.some(f => f.endsWith('.py'));
    if (hasAnyPy) return 'python';
  } catch (e) {}

  return 'unknown';
}

/**
 * Clones a bot repository
 */
export async function cloneBot(bot) {
  ensureBotsDir();
  const dest = getBotPath(bot.id);
  
  if (fs.existsSync(dest)) {
    console.log(`Directory for bot ${bot.name} already exists. Cleaning up first.`);
    fs.rmSync(dest, { recursive: true, force: true });
  }

  console.log(`Cloning ${bot.gitUrl} to ${dest}...`);
  const git = simpleGit();
  await git.clone(bot.gitUrl, dest);
  console.log(`Cloned ${bot.name} successfully.`);
}

/**
 * Installs dependencies for a bot (supports npm install or pip install)
 */
export function installDependencies(bot) {
  return new Promise((resolve, reject) => {
    const dest = getBotPath(bot.id);
    if (!fs.existsSync(dest)) {
      return reject(new Error('Bot directory does not exist. Clone it first.'));
    }

    const runtime = detectLanguage(dest);
    console.log(`Installing dependencies for ${bot.name} (${runtime} runtime)...`);

    let cmd = '';
    let args = [];
    let useShell = false;

    if (runtime === 'node') {
      if (!fs.existsSync(path.join(dest, 'package.json'))) {
        console.log('No package.json found, skipping npm install.');
        return resolve();
      }
      cmd = 'npm';
      args = ['install', '--production'];
      useShell = true;
    } else if (runtime === 'python') {
      if (!fs.existsSync(path.join(dest, 'requirements.txt'))) {
        console.log('No requirements.txt found, skipping pip install.');
        return resolve();
      }
      cmd = 'python';
      args = ['-m', 'pip', 'install', '-r', 'requirements.txt'];
      useShell = false;
    } else {
      console.log(`Unknown runtime runtime for bot ${bot.name}. Skipping installation.`);
      return resolve();
    }

    const child = spawn(cmd, args, { cwd: dest, shell: useShell });
    let errorOutput = '';

    child.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`Dependencies installed successfully for ${bot.name}.`);
        resolve();
      } else {
        console.error(`Dependency install failed for ${bot.name} with code ${code}. Error: ${errorOutput}`);
        reject(new Error(`Installation failed with code ${code}. ${errorOutput.slice(0, 100)}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Writes the configured .env file for a bot
 */
export function writeEnvFile(bot) {
  const dest = getBotPath(bot.id);
  if (!fs.existsSync(dest)) {
    throw new Error('Bot directory does not exist. Clone it first.');
  }

  const envPath = path.join(dest, '.env');
  let envContent = '';

  const vars = bot.envVars instanceof Map ? Object.fromEntries(bot.envVars) : bot.envVars || {};

  for (const [key, value] of Object.entries(vars)) {
    let parsedValue = value;
    if (typeof value === 'string' && value.startsWith('postgres://')) {
      parsedValue = value.replace('postgres://', 'postgresql://');
    }
    envContent += `${key}=${parsedValue}\n`;
  }

  if (!envContent.includes('PORT=')) {
    const randomPort = Math.floor(Math.random() * 5000) + 20000;
    envContent += `PORT=${randomPort}\n`;
  }

  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log(`Created .env file for ${bot.name}`);
}

/**
 * Starts a bot process (detects and spawns node or python)
 */
export async function startBot(bot) {
  const botId = bot.id;
  
  if (activeBots.has(botId)) {
    await stopBot(botId);
  }

  const dest = getBotPath(botId);
  if (!fs.existsSync(dest)) {
    console.log(`Bot directory not found for ${bot.name}. Rebuilding (clone -> install -> env)...`);
    await cloneBot(bot);
    await installDependencies(bot);
    writeEnvFile(bot);
  } else {
    // Run dependency installer (safely checks if requirements/modules need updating)
    await installDependencies(bot);
    writeEnvFile(bot);
  }

  const runtime = detectLanguage(dest);
  
  let cmd = '';
  let args = [];
  let useShell = false;

  if (runtime === 'node') {
    cmd = process.execPath;
    args = ['index.js'];
    useShell = false;

    const packageJsonPath = path.join(dest, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.scripts && packageJson.scripts.start) {
          cmd = 'npm';
          args = ['start'];
          useShell = true;
        } else if (packageJson.main) {
          args = [packageJson.main];
        }
      } catch (e) {}
    }
  } else if (runtime === 'python') {
    cmd = 'python';
    useShell = false;
    // -u flag disables buffering in stdout/stderr, enabling real-time logging
    args = ['-u']; 
    
    if (fs.existsSync(path.join(dest, 'main.py'))) {
      args.push('main.py');
    } else if (fs.existsSync(path.join(dest, 'bot.py'))) {
      args.push('bot.py');
    } else {
      const files = fs.readdirSync(dest);
      const pyFile = files.find(f => f.endsWith('.py'));
      if (pyFile) {
        args.push(pyFile);
      } else {
        args.push('main.py');
      }
    }
  } else {
    // Default fallback
    cmd = process.execPath;
    args = ['index.js'];
    useShell = false;
  }

  console.log(`Starting ${runtime} bot process: ${bot.name} (${cmd} ${args.join(' ')})`);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { 
      cwd: dest, 
      shell: useShell,
      env: getChildEnv(dest)
    });

    const botRecord = {
      process: child,
      logs: [],
      restartCount: activeBots.has(botId) ? activeBots.get(botId).restartCount : 0,
      startedAt: Date.now()
    };

    activeBots.set(botId, botRecord);

    const addLog = (message) => {
      const timestamp = new Date().toISOString().substring(11, 19);
      botRecord.logs.push({
        time: Date.now(),
        text: `[${timestamp}] ${message}`
      });
      if (botRecord.logs.length > 300) {
        botRecord.logs.shift();
      }
    };

    addLog(`System: Starting bot process (${cmd} ${args.join(' ')})`);

    child.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(line => {
        if (line.trim()) addLog(line);
      });
    });

    child.stderr.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(line => {
        if (line.trim()) addLog(`ERROR: ${line}`);
      });
    });

    let startupPassed = false;

    // Wait 10 seconds to verify startup success
    const startupTimeout = setTimeout(async () => {
      startupPassed = true;
      await db.updateBot(botId, { status: 'running', isActive: true });
      resolve({ success: true });
    }, 10000);

    child.on('close', async (code) => {
      addLog(`System: Process exited with code ${code}`);
      console.log(`Bot process ${bot.name} exited with code ${code}`);
      
      const logsText = botRecord.logs.map(log => log.text).join('\n');
      const hasInvalidToken = logsText.includes('InvalidToken') || 
                              logsText.includes('rejected by the server') || 
                              logsText.includes('401 Unauthorized') ||
                              logsText.includes('Unauthorized') ||
                              logsText.includes('invalid token') ||
                              logsText.includes('rejected');
      const hasMissingDb = logsText.includes('No database URLs configured') || 
                           logsText.includes('ValueError: No database URLs');
      const hasDialectError = logsText.includes('NoSuchModuleError');

      const isFatal = hasInvalidToken || hasMissingDb || hasDialectError;

      if (isFatal) {
        addLog(`System: Fatal error detected. Disabling bot auto-start.`);
        await db.updateBot(botId, { isActive: false, status: 'error' });
        activeBots.delete(botId);
        
        if (!startupPassed) {
          clearTimeout(startupTimeout);
          const errorLogs = botRecord.logs.slice(-15).map(log => log.text).join('\n');
          reject(new Error(errorLogs || `Bot process exited with fatal error (code ${code})`));
        }
        return;
      }
      
      if (!startupPassed) {
        clearTimeout(startupTimeout);
        await db.updateBot(botId, { status: 'error', isActive: false });
        activeBots.delete(botId);
        
        // Collate error logs
        const errorLogs = botRecord.logs.slice(-15).map(log => log.text).join('\n');
        reject(new Error(errorLogs || `Bot process exited immediately with code ${code}`));
      } else {
        const currentBot = await db.getBot(botId);
        if (currentBot && currentBot.isActive) {
          const record = activeBots.get(botId);
          if (record && record.restartCount < 5) {
            record.restartCount++;
            const delay = Math.min(record.restartCount * 5000, 30000);
            addLog(`System: Unexpected crash. Restarting in ${delay / 1000}s (Attempt ${record.restartCount}/5)...`);
            
            setTimeout(async () => {
              const reCheck = await db.getBot(botId);
              if (reCheck && reCheck.isActive) {
                try {
                  await startBot(reCheck);
                } catch (err) {
                  console.error(`Failed to auto-restart bot ${bot.name}:`, err);
                }
              }
            }, delay);
          } else {
            addLog(`System: Max restart attempts (5) reached. Bot stopped.`);
            await db.updateBot(botId, { isActive: false, status: 'error' });
          }
        } else {
          await db.updateBot(botId, { status: 'stopped' });
          activeBots.delete(botId);
        }
      }
    });

    child.on('error', async (err) => {
      addLog(`System Error: ${err.message}`);
      console.error(`Process error for ${bot.name}:`, err);
      
      if (!startupPassed) {
        clearTimeout(startupTimeout);
        await db.updateBot(botId, { status: 'error', isActive: false });
        activeBots.delete(botId);
        reject(err);
      }
    });
  });
}

/**
 * Stops a bot process
 */
export async function stopBot(botId) {
  const record = activeBots.get(botId);
  if (record) {
    record.restartCount = 0;
    const child = record.process;
    
    return new Promise((resolve) => {
      db.updateBot(botId, { isActive: false, status: 'stopped' }).then(() => {
        if (child) {
          child.kill('SIGTERM');
          const killTimeout = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch (e) {}
          }, 3000);

          child.on('close', () => {
            clearTimeout(killTimeout);
            activeBots.delete(botId);
            resolve(true);
          });
        } else {
          activeBots.delete(botId);
          resolve(true);
        }
      });
    });
  } else {
    await db.updateBot(botId, { isActive: false, status: 'stopped' });
    return false;
  }
}

/**
 * Gets the running log buffer for a bot
 */
export function getBotLogs(botId) {
  const record = activeBots.get(botId);
  if (record && record.logs) {
    const fiveMinsAgo = Date.now() - 5 * 60 * 1000;
    const filtered = record.logs
      .filter(log => log.time >= fiveMinsAgo)
      .map(log => log.text);
      
    if (filtered.length === 0) {
      return 'No logs captured in the last 5 minutes.';
    }
    return filtered.join('\n');
  }
  return 'No logs captured. Bot is not running.';
}

/**
 * Gets the uptime of a running bot in a human-readable format
 */
export function getBotUptime(botId) {
  const record = activeBots.get(botId);
  if (!record || !record.startedAt) return null;
  
  const diffMs = Date.now() - record.startedAt;
  const diffSecs = Math.floor(diffMs / 1000);
  const mins = Math.floor(diffSecs / 60);
  const hours = Math.floor(mins / 60);
  
  if (hours > 0) {
    return `${hours}h ${mins % 60}m`;
  }
  if (mins > 0) {
    return `${mins}m ${diffSecs % 60}s`;
  }
  return `${diffSecs}s`;
}

/**
 * Delete a bot's cloned files from disk
 */
export async function deleteBotFiles(botId) {
  await stopBot(botId);
  const dest = getBotPath(botId);
  if (fs.existsSync(dest)) {
    console.log(`Deleting files for bot id: ${botId}...`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

/**
 * Stops bot, deletes cloned directory, re-clones, reinstalls, and restarts
 */
export async function updateBotCode(bot) {
  const botId = bot.id;
  
  if (activeBots.has(botId)) {
    await stopBot(botId);
  }

  const dest = getBotPath(botId);
  if (fs.existsSync(dest)) {
    console.log(`Deleting old files for bot ${bot.name} before re-cloning...`);
    fs.rmSync(dest, { recursive: true, force: true });
  }

  // Re-clone, reinstall, rewrite env, and start bot process
  await cloneBot(bot);
  await installDependencies(bot);
  writeEnvFile(bot);
  await startBot(bot);
}
