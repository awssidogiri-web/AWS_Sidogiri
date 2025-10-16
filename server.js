/**
 * server.js
 * Full Render.com server with:
 * - Google Sheets logging (no wifi_rssi)
 * - /set_trigger Telegram command
 * - state persistence to system_state.json and restore from Sheets
 */

import express from "express";
import fs from "fs";
import path from "path";
import TelegramBot from "node-telegram-bot-api";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

// -----------------------------
// Config / env checks (adjust names as you use in Render)
// -----------------------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;
const SHEET_ID = process.env.SPREADSHEET_ID || null;

// Google service account may be provided either as JSON string in GOOGLE_CREDENTIALS
// or via local file service-account.json (development)
let googleCredentials = null;
if (process.env.GOOGLE_CREDENTIALS) {
  try {
    googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } catch (e) {
    console.error("❌ Failed to parse GOOGLE_CREDENTIALS:", e.message);
    process.exit(1);
  }
} else {
  // Attempt to load local service-account.json for development
  const localPath = path.join(process.cwd(), "service-account.json");
  if (fs.existsSync(localPath)) {
    googleCredentials = JSON.parse(fs.readFileSync(localPath, "utf8"));
  } else {
    console.warn("⚠️ GOOGLE_CREDENTIALS not found in env and service-account.json not present.");
  }
}

// Basic env validation
if (!TELEGRAM_BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN is required (set TELEGRAM_BOT_TOKEN env)");
  process.exit(1);
}
if (!SHEET_ID) {
  console.error("❌ SPREADSHEET_ID is required (set SPREADSHEET_ID env)");
  process.exit(1);
}
if (!googleCredentials || !googleCredentials.client_email || !googleCredentials.private_key) {
  console.error("❌ Google credentials missing or invalid.");
  process.exit(1);
}

// -----------------------------
// Express setup
// -----------------------------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  // CORS for IoT nodes if needed
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// -----------------------------
// System state
// -----------------------------
let systemState = {
  currentWaterLevel: 0,
  triggerLevel: 50,            // default trigger level in cm
  alarmActive: false,
  manualOverride: false,
  lastReading: null,
  alarmStartTime: null,
  connectionCount: 0,
  sheetsInitialized: false,
  deploymentInfo: {
    platform: process.env.RENDER ? "Render.com" : "Local",
    environment: process.env.NODE_ENV || "development",
    version: "1.0.0"
  }
};

// -----------------------------
// Local JSON backup for quick restore
// -----------------------------
const STATE_FILE = path.join(process.cwd(), "system_state.json");

function saveSystemState() {
  try {
    const toSave = {
      currentWaterLevel: systemState.currentWaterLevel,
      triggerLevel: systemState.triggerLevel,
      alarmActive: systemState.alarmActive,
      manualOverride: systemState.manualOverride,
      lastReading: systemState.lastReading,
      alarmStartTime: systemState.alarmStartTime,
      connectionCount: systemState.connectionCount
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(toSave, null, 2));
    console.log("💾 System state saved to system_state.json");
  } catch (err) {
    console.error("❌ Failed to save system state:", err.message);
  }
}

function loadSystemStateFromFile() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf8");
      const saved = JSON.parse(raw);
      Object.assign(systemState, saved);
      console.log("✅ Loaded system state from file:", saved);
    } else {
      console.log("⚠️ No local system_state.json found.");
    }
  } catch (err) {
    console.error("❌ Error loading local system state:", err.message);
  }
}

// -----------------------------
// Google Sheets setup & helpers
// -----------------------------
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const jwt = new JWT({
  email: googleCredentials.client_email,
  key: googleCredentials.private_key.replace(/\\n/g, "\n"),
  scopes: SCOPES
});
const doc = new GoogleSpreadsheet(SHEET_ID, jwt);

async function ensureCurrentMonthSheet() {
  try {
    await doc.loadInfo();
    const now = new Date();
    const sheetName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`; // YYYY-MM
    let sheet = doc.sheetsByTitle[sheetName];
    if (!sheet) {
      sheet = await doc.addSheet({
        title: sheetName,
        headerValues: ["timestamp", "elevasi muka air", "trigger level", "status alarm", "node_id"]
      });
      console.log("🆕 Created sheet:", sheetName);
    } else {
      // ensure header contains expected columns (skip complex checks for brevity)
      // we assume the sheet header is correct if it exists
    }
    systemState.sheetsInitialized = true;
    return sheet;
  } catch (err) {
    console.error("❌ ensureCurrentMonthSheet error:", err.message);
    throw err;
  }
}

async function logToSheets(waterLevel, triggerLevel, alarmStatus, nodeId = "unknown") {
  try {
    if (!systemState.sheetsInitialized) {
      // attempt to init if not done
      await ensureCurrentMonthSheet();
    }
    const sheet = await ensureCurrentMonthSheet();
    const row = {
      timestamp: new Date().toISOString(),
      "elevasi muka air": Number.isFinite(waterLevel) ? parseFloat(waterLevel.toFixed(2)) : "",
      "trigger level": Number.isFinite(triggerLevel) ? parseFloat(triggerLevel.toFixed(2)) : "",
      "status alarm": alarmStatus ? "ON" : "OFF",
      node_id: nodeId || "unknown"
    };
    const added = await sheet.addRow(row);
    console.log("📈 Logged to Sheets (row):", added.rowNumber);
    return { success: true, rowNumber: added.rowNumber };
  } catch (err) {
    console.error("❌ logToSheets failed:", err.message);
    return { success: false, error: err.message };
  }
}

// Restore latest state from Google Sheet (last row)
async function restoreStateFromSheets() {
  try {
    const sheet = await ensureCurrentMonthSheet();
    // If no rows, skip
    if (!sheet || sheet.rowCount === 0) {
      console.log("⚠️ No rows in sheet to restore from");
      return;
    }
    // Fetch last row
    // google-spreadsheet getRows is not very performant for huge sheets; offset technique:
    const rows = await sheet.getRows({ limit: 1, offset: Math.max(0, sheet.rowCount - 1) });
    if (rows && rows.length > 0) {
      const last = rows[0];
      if (last["status alarm"]) {
        systemState.alarmActive = String(last["status alarm"]).toUpperCase() === "ON";
      }
      const wl = parseFloat(last["elevasi muka air"]);
      if (!isNaN(wl)) systemState.currentWaterLevel = wl;
      const trig = parseFloat(last["trigger level"]);
      if (!isNaN(trig)) systemState.triggerLevel = trig;
      systemState.lastReading = last["timestamp"] || systemState.lastReading;
      console.log("✅ Restored state from Sheets (last row):", {
        currentWaterLevel: systemState.currentWaterLevel,
        triggerLevel: systemState.triggerLevel,
        alarmActive: systemState.alarmActive
      });
    } else {
      console.log("⚠️ Could not read last row from sheet");
    }
  } catch (err) {
    console.error("❌ restoreStateFromSheets error:", err.message);
  }
}

// -----------------------------
// Telegram bot initialization
// -----------------------------
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Helper to send to configured CHAT_ID (if provided) else reply to user
async function sendTelegram(chatIdOrMessage, text) {
  try {
    const target = TELEGRAM_CHAT_ID || (chatIdOrMessage && chatIdOrMessage.chat && chatIdOrMessage.chat.id) || chatIdOrMessage;
    if (!target) {
      console.log("ℹ️ Telegram target not configured; message:", text);
      return;
    }
    await bot.sendMessage(target, text, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("❌ Telegram send error:", err.message);
  }
}

// -----------------------------
// Telegram commands
// -----------------------------
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcome = `🌊 AWS Sidogiri Bot\nCommands:\n/status\n/set_trigger <cm>\n/alarm_on\n/alarm_off\n/history\n/health`;
  bot.sendMessage(chatId, welcome);
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const lastReading = systemState.lastReading ? new Date(systemState.lastReading).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "N/A";
  const message = `📊 *STATUS SISTEM*\n\n💧 Water Level: ${systemState.currentWaterLevel} cm\n🎚 Trigger Level: ${systemState.triggerLevel} cm\n🚨 Alarm: ${systemState.alarmActive ? "ON" : "OFF"}\n🔧 Manual Override: ${systemState.manualOverride ? "YES" : "NO"}\n🕒 Last Reading: ${lastReading}\n\nPlatform: ${systemState.deploymentInfo.platform}`;
  bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
});

// Set trigger level via Telegram: /set_trigger 75
bot.onText(/\/set_trigger (\d+(?:\.\d+)?)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const newVal = parseFloat(match[1]);
  if (isNaN(newVal) || newVal <= 0) {
    return bot.sendMessage(chatId, "❌ Invalid trigger. Usage: /set_trigger 75");
  }
  systemState.triggerLevel = newVal;
  saveSystemState();

  // Log to Sheets (as a manual trigger change event)
  try {
    await logToSheets(systemState.currentWaterLevel, newVal, systemState.alarmActive, "manual_trigger_change");
  } catch (e) {
    console.error("❌ Could not log trigger change to Sheets:", e.message);
  }

  bot.sendMessage(chatId, `✅ Trigger level updated to ${newVal} cm`);
  console.log(`⚙️ Trigger changed to ${newVal} cm via Telegram`);
});

bot.onText(/\/alarm_on/, async (msg) => {
  const chatId = msg.chat.id;
  systemState.alarmActive = true;
  systemState.manualOverride = true;
  systemState.alarmStartTime = new Date().toISOString();
  saveSystemState();

  // Log manual on
  await logToSheets(systemState.currentWaterLevel, systemState.triggerLevel, true, "manual_on");

  bot.sendMessage(chatId, "🚨 Alarm activated manually.");
  // Auto-off after 4 minutes
  setTimeout(async () => {
    if (systemState.alarmActive && systemState.manualOverride) {
      systemState.alarmActive = false;
      systemState.manualOverride = false;
      systemState.alarmStartTime = null;
      saveSystemState();
      await logToSheets(systemState.currentWaterLevel, systemState.triggerLevel, false, "auto_off");
      bot.sendMessage(chatId, "⏰ Alarm automatically turned OFF after 4 minutes.");
    }
  }, 240000);
});

bot.onText(/\/alarm_off/, async (msg) => {
  const chatId = msg.chat.id;
  systemState.alarmActive = false;
  systemState.manualOverride = false;
  systemState.alarmStartTime = null;
  saveSystemState();
  await logToSheets(systemState.currentWaterLevel, systemState.triggerLevel, false, "manual_off");
  bot.sendMessage(chatId, "🔕 Alarm turned OFF manually.");
});

// Simple history command: fetch last few rows (light weight)
bot.onText(/\/history/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const sheet = await ensureCurrentMonthSheet();
    const limit = 5;
    const offset = Math.max(0, sheet.rowCount - limit);
    const rows = await sheet.getRows({ limit, offset });
    if (!rows || rows.length === 0) {
      return bot.sendMessage(chatId, "📭 No history available.");
    }
    let reply = "📈 Last readings:\n";
    rows.reverse().forEach(r => {
      reply += `\n• ${r.timestamp} — ${r["elevasi muka air"]} cm — ${r["status alarm"]} — ${r.node_id}`;
    });
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("❌ /history error:", err.message);
    bot.sendMessage(chatId, "❌ Failed to fetch history");
  }
});

// -----------------------------
// API: accept sensor data
// -----------------------------
app.post("/api/sensor/data", async (req, res) => {
  try {
    const body = req.body || {};
    const water_level = Number(body.water_level);
    const node_id = body.node_id || "unknown";

    if (!Number.isFinite(water_level)) {
      return res.status(400).json({ success: false, error: "water_level must be numeric" });
    }

    // Update state
    systemState.currentWaterLevel = water_level;
    systemState.lastReading = new Date().toISOString();
    systemState.connectionCount = (systemState.connectionCount || 0) + 1;

    // Alarm logic
    if (water_level >= systemState.triggerLevel && !systemState.manualOverride) {
      if (!systemState.alarmActive) {
        systemState.alarmActive = true;
        systemState.alarmStartTime = new Date().toISOString();
        // notify
        if (TELEGRAM_CHAT_ID) sendTelegram(TELEGRAM_CHAT_ID, `🚨 Automatic alarm: water level ${water_level} cm (>= ${systemState.triggerLevel} cm)`);
        await logToSheets(water_level, systemState.triggerLevel, true, node_id);
      } else {
        // already active; we may still log current reading
        await logToSheets(water_level, systemState.triggerLevel, true, node_id);
      }
    } else {
      // if currently active but now below threshold and not manual override -> turn off and log
      if (systemState.alarmActive && !systemState.manualOverride && water_level < systemState.triggerLevel) {
        systemState.alarmActive = false;
        systemState.alarmStartTime = null;
        if (TELEGRAM_CHAT_ID) sendTelegram(TELEGRAM_CHAT_ID, `✅ Alarm OFF: water level ${water_level} cm (< ${systemState.triggerLevel} cm)`);
        await logToSheets(water_level, systemState.triggerLevel, false, node_id);
      } else {
        // just a normal reading, log to sheets (alarmStatus reflects current state)
        await logToSheets(water_level, systemState.triggerLevel, systemState.alarmActive, node_id);
      }
    }

    saveSystemState();
    return res.json({ success: true, status: "processed" });
  } catch (err) {
    console.error("❌ /api/sensor/data error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------
// API: alarm status (for alarm node)
// -----------------------------
app.get("/api/alarm/status", (req, res) => {
  return res.json({
    alarm_state: systemState.alarmActive ? "on" : "off",
    trigger_level: systemState.triggerLevel,
    manual_override: systemState.manualOverride,
    water_level: systemState.currentWaterLevel,
    sheets_status: systemState.sheetsInitialized ? "ok" : "error",
    server_time: new Date().toISOString(),
    alarm_start_time: systemState.alarmStartTime,
    platform: systemState.deploymentInfo.platform
  });
});

// -----------------------------
// Health & system info endpoints
// -----------------------------
app.get("/", (req, res) => {
  res.json({
    message: "AWS Sidogiri Server",
    version: systemState.deploymentInfo.version,
    platform: systemState.deploymentInfo.platform,
    time: new Date().toISOString()
  });
});

app.get("/api/health", async (req, res) => {
  res.json({
    server_time: new Date().toISOString(),
    sheets_initialized: systemState.sheetsInitialized,
    alarm_active: systemState.alarmActive,
    trigger_level: systemState.triggerLevel,
    last_reading: systemState.lastReading,
    connection_count: systemState.connectionCount
  });
});

// -----------------------------
// Startup sequence
// -----------------------------
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    console.log("🚀 Starting server...");
    // load local file state first (fast)
    loadSystemStateFromFile();

    // init Google Sheets (auth handled by jwt above)
    try {
      await doc.loadInfo();
      console.log("✅ Google Sheets loaded:", doc.title);
    } catch (err) {
      console.error("❌ Could not load Google Sheets:", err.message);
      // continue; sheet ops will fail until fixed
    }

    // restore from sheets (if possible) - sheet restoration will override file if sheet has newer data
    try {
      await restoreStateFromSheets();
      // save again after restore
      saveSystemState();
    } catch (err) {
      console.warn("⚠️ Skipped restore from sheets:", err.message);
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`📡 Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ startServer failed:", err.message);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("🛑 SIGINT received, exiting...");
  saveSystemState();
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, exiting...");
  saveSystemState();
  process.exit(0);
});
