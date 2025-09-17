const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Add CORS and security headers middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, ngrok-skip-browser-warning');
    
    // Security headers
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    res.header('X-XSS-Protection', '1; mode=block');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Load credentials - support both local development and Render production
let credentials, telegramToken, spreadsheetId;

try {
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🚀 Platform: ${process.env.RENDER ? 'Render.com' : 'Local'}`);

    // Check if running on Render (production)
    if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
        console.log('☁️ Loading credentials from environment variables (Production)');
        
        // Load from environment variables
        telegramToken = process.env.TELEGRAM_BOT_TOKEN;
        spreadsheetId = process.env.SPREADSHEET_ID;

        if (!telegramToken) {
            throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
        }
        if (!spreadsheetId) {
            throw new Error('SPREADSHEET_ID environment variable is required');
        }

        // Google credentials from environment variable (JSON string)
        if (process.env.GOOGLE_CREDENTIALS) {
            try {
                credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
                console.log('✅ Google credentials parsed from environment variable');
            } catch (parseError) {
                throw new Error(`Failed to parse GOOGLE_CREDENTIALS: ${parseError.message}`);
            }
        } else {
            throw new Error('GOOGLE_CREDENTIALS environment variable is required');
        }
    } else {
        // Local development - use files
        console.log('🛠️ Loading credentials from files (Development)');
        const credentialsPath = process.env.CREDENTIALS_PATH || process.cwd();

        try {
            const serviceAccountPath = path.join(credentialsPath, 'service-account.json');
            credentials = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
            console.log('✅ Service account loaded from file');
        } catch (fileError) {
            throw new Error(`Failed to load service-account.json: ${fileError.message}`);
        }

        try {
            const configPath = path.join(credentialsPath, 'config.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            telegramToken = config.telegram_bot_token;
            spreadsheetId = config.spreadsheet_id;
            console.log('✅ Config loaded from file');
        } catch (configError) {
            throw new Error(`Failed to load config.json: ${configError.message}`);
        }
    }

    // Validate all required credentials
    if (!credentials || !credentials.client_email || !credentials.private_key) {
        throw new Error('Invalid Google service account credentials');
    }

    console.log('✅ All credentials loaded successfully');
    console.log('📊 Spreadsheet ID:', spreadsheetId);
    console.log('👤 Service Account:', credentials.client_email);
    console.log('🤖 Bot Token:', telegramToken ? '✅ Present' : '❌ Missing');

} catch (error) {
    console.error('❌ Error loading credentials:', error.message);
    console.error('💡 Environment Variables Required for Production:');
    console.error('  - TELEGRAM_BOT_TOKEN');
    console.error('  - SPREADSHEET_ID');
    console.error('  - GOOGLE_CREDENTIALS (full JSON as string)');
    console.error('💡 For development: ensure service-account.json and config.json exist');
    process.exit(1);
}

// Initialize services
let doc;
const serviceAccountAuth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const bot = new TelegramBot(telegramToken, { polling: true });

// System state
let systemState = {
    currentWaterLevel: 0,
    triggerLevel: 50, // cm
    alarmActive: false,
    manualOverride: false,
    lastReading: null,
    alarmStartTime: null,
    sheetsInitialized: false,
    serverStartTime: new Date(),
    connectionCount: 0,
    lastConnectionTime: null,
    deploymentInfo: {
        platform: process.env.RENDER ? 'Render.com' : 'Local',
        environment: process.env.NODE_ENV || 'development',
        version: '2.0.0-render'
    }
};

// Initialize Google Sheets with proper error handling
async function initializeSheets() {
    try {
        console.log('📊 Initializing Google Sheets...');

        // Create new document instance with service account auth
        doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
        console.log('✅ Authentication successful');

        // Load document info
        await doc.loadInfo();
        console.log('✅ Connected to Google Sheets:', doc.title);
        console.log('📄 Total sheets:', doc.sheetCount);

        // List available sheets
        console.log('📋 Available sheets:');
        Object.values(doc.sheetsByTitle).forEach(sheet => {
            console.log(`  - ${sheet.title} (${sheet.rowCount} rows)`);
        });

        // Ensure current month sheet exists
        await ensureCurrentMonthSheet();

        systemState.sheetsInitialized = true;
        console.log('✅ Google Sheets initialization complete');

    } catch (error) {
        console.error('❌ Error initializing sheets:', error.message);
        console.error('🔍 Error details:', error);

        // Additional debugging info
        if (error.message.includes('auth') || error.message.includes('credentials')) {
            console.error('🔐 Authentication issue detected');
            console.error('🔧 Service account email:', credentials.client_email);
            console.error('🔑 Private key available:', !!credentials.private_key);
            console.error('📊 Spreadsheet ID:', spreadsheetId);
            console.error('💡 Make sure the service account has access to the spreadsheet');
        }

        systemState.sheetsInitialized = false;
        console.log('⚠️ Server will continue running without Sheets integration');
    }
}

// Ensure current month sheet exists with proper headers
async function ensureCurrentMonthSheet() {
    try {
        const currentDate = new Date();
        const sheetName = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;

        let sheet = doc.sheetsByTitle[sheetName];

        if (!sheet) {
            console.log(`🆕 Creating new sheet: ${sheetName}`);
            sheet = await doc.addSheet({
                title: sheetName,
                headerValues: ['timestamp', 'elevasi muka air', 'trigger level', 'status alarm', 'node_id', 'wifi_rssi']
            });
            console.log('✅ New sheet created with headers');
            
            // Reload document info
            await doc.loadInfo();
        } else {
            console.log(`📄 Using existing sheet: ${sheetName}`);
        }

        return sheet;
    } catch (error) {
        console.error('❌ Error ensuring sheet exists:', error.message);
        throw error;
    }
}

// Log data to Google Sheets with improved error handling
async function logToSheets(waterLevel, triggerLevel, alarmStatus, nodeId = null, wifiRssi = null) {
    if (!systemState.sheetsInitialized) {
        console.log('⚠️ Skipping sheets logging - not initialized');
        return { success: false, error: 'Sheets not initialized' };
    }

    try {
        console.log('📝 Logging to sheets...');

        // Ensure doc info is loaded
        if (!doc.title) {
            console.log('📄 Reloading document info...');
            await doc.loadInfo();
        }

        const sheet = await ensureCurrentMonthSheet();
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

        const rowData = {
            'timestamp': timestamp,
            'elevasi muka air': parseFloat(waterLevel.toFixed(2)),
            'trigger level': parseFloat(triggerLevel.toFixed(2)),
            'status alarm': alarmStatus ? 'ON' : 'OFF',
            'node_id': nodeId || 'unknown',
            'wifi_rssi': wifiRssi || ''
        };

        console.log('📊 Row data to insert:', rowData);

        const result = await sheet.addRow(rowData);
        console.log('✅ Data logged to sheets successfully');
        console.log('📢 Row number:', result.rowNumber);

        return { success: true, rowNumber: result.rowNumber };

    } catch (error) {
        console.error('❌ Error logging to sheets:', error.message);
        console.error('🔍 Full error:', error);

        // Try to reinitialize sheets on error
        if (error.message.includes('loadInfo') || error.message.includes('not found')) {
            console.log('🔄 Attempting to reinitialize sheets...');
            try {
                await initializeSheets();
                // Retry once
                return await logToSheets(waterLevel, triggerLevel, alarmStatus, nodeId, wifiRssi);
            } catch (retryError) {
                console.error('❌ Retry failed:', retryError.message);
            }
        }

        return { success: false, error: error.message };
    }
}

// Send Telegram notification
async function sendTelegramNotification(chatId, message) {
    try {
        if (chatId) {
            await bot.sendMessage(chatId, message);
        } else {
            console.log('📱 Telegram notification:', message);
        }
    } catch (error) {
        console.error('❌ Error sending telegram message:', error.message);
    }
}

// Send sensor data notification to Telegram
async function sendSensorDataNotification(waterLevel, triggerLevel, alarmStatus, nodeId, wifiRssi, sheetsResult) {
    try {
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const statusIcon = alarmStatus ? '🚨' : '✅';
        const sheetsIcon = sheetsResult.success ? '📊✅' : '📊❌';

        const notificationMessage = `${statusIcon} SENSOR DATA UPDATE\n\n` +
            `💧 Water Level: ${waterLevel} cm\n` +
            `⚡ Trigger Level: ${triggerLevel} cm\n` +
            `🚨 Alarm Status: ${alarmStatus ? 'ON' : 'OFF'}\n` +
            `📡 Node ID: ${nodeId || 'unknown'}\n` +
            `📶 WiFi RSSI: ${wifiRssi || 'N/A'} dBm\n` +
            `${sheetsIcon} Sheets: ${sheetsResult.success ? 'Logged' : 'Failed'}\n` +
            `🕒 Time: ${timestamp}\n` +
            `🚀 Platform: ${systemState.deploymentInfo.platform}`;

        await sendTelegramNotification(-1002914064186, notificationMessage);
        console.log('📱 Sensor data notification sent to Telegram');

    } catch (error) {
        console.error('❌ Error sending sensor data notification:', error.message);
    }
}

// Check alarm conditions
function checkAlarmConditions() {
    const shouldAlarm = !systemState.manualOverride && 
                       systemState.currentWaterLevel >= systemState.triggerLevel;

    if (shouldAlarm && !systemState.alarmActive) {
        // Activate alarm
        systemState.alarmActive = true;
        systemState.alarmStartTime = new Date();
        console.log('🚨 ALARM ACTIVATED - Water level reached trigger!');

        sendTelegramNotification(-1002914064186,
            `🚨 ALARM ACTIVATED!\n` +
            `Water Level: ${systemState.currentWaterLevel} cm\n` +
            `Trigger Level: ${systemState.triggerLevel} cm\n` +
            `Time: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n` +
            `Platform: ${systemState.deploymentInfo.platform}`
        );

        // Set 4-minute auto-off timer
        setTimeout(() => {
            if (systemState.alarmActive && !systemState.manualOverride) {
                systemState.alarmActive = false;
                systemState.alarmStartTime = null;
                console.log('⏰ Alarm auto-turned OFF after 4 minutes');
                sendTelegramNotification(-1002914064186, '⏰ Alarm automatically turned OFF after 4 minutes');
            }
        }, 240000); // 4 minutes
    }
}

// API Routes

// Root route for testing - shows deployment info
app.get('/', (req, res) => {
    const uptime = Math.floor(process.uptime());
    const uptimeHours = Math.floor(uptime / 3600);
    const uptimeMinutes = Math.floor((uptime % 3600) / 60);

    res.json({
        message: 'AWS (Automatic Water Level System) Server',
        status: 'running',
        timestamp: new Date().toISOString(),
        uptime: `${uptimeHours}h ${uptimeMinutes}m ${uptime % 60}s`,
        deployment: systemState.deploymentInfo,
        endpoints: {
            health: '/api/health',
            sensor_data: '/api/sensor/data',
            alarm_status: '/api/alarm/status'
        },
        current_status: {
            water_level: systemState.currentWaterLevel,
            alarm_active: systemState.alarmActive,
            trigger_level: systemState.triggerLevel,
            sheets_connected: systemState.sheetsInitialized,
            last_reading: systemState.lastReading,
            connection_count: systemState.connectionCount
        }
    });
});

// Receive sensor data with improved logging
app.post('/api/sensor/data', async (req, res) => {
    const startTime = Date.now();
    const clientIP = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];

    // Update connection statistics
    systemState.connectionCount++;
    systemState.lastConnectionTime = new Date();

    try {
        console.log('\n=== INCOMING SENSOR DATA ===');
        console.log('🌐 Client IP:', clientIP);
        console.log('🔗 Connection #:', systemState.connectionCount);
        console.log('📥 Request body:', JSON.stringify(req.body, null, 2));

        const { water_level, sensor_status, node_id, wifi_rssi, timestamp, uptime_seconds } = req.body;

        // Validate required fields
        if (typeof water_level !== 'number') {
            console.log('❌ Invalid water_level:', water_level);
            return res.status(400).json({
                success: false,
                error: 'water_level must be a number',
                received: { type: typeof water_level, value: water_level }
            });
        }

        if (sensor_status !== 'ok') {
            console.log('❌ Invalid sensor_status:', sensor_status);
            return res.status(400).json({
                success: false,
                error: 'sensor_status must be "ok"',
                received: sensor_status
            });
        }

        // Update system state
        systemState.currentWaterLevel = water_level;
        systemState.lastReading = new Date();

        console.log(`📊 Sensor data: ${water_level} cm from ${node_id || 'unknown'}`);
        console.log(`📶 WiFi RSSI: ${wifi_rssi || 'N/A'} dBm`);
        console.log(`⏱️ Uptime: ${uptime_seconds || 'N/A'} seconds`);

        // Check alarm conditions
        checkAlarmConditions();

        // Log to Google Sheets
        console.log('📊 Logging to Google Sheets...');
        const sheetsResult = await logToSheets(
            water_level,
            systemState.triggerLevel,
            systemState.alarmActive,
            node_id,
            wifi_rssi
        );

        // Send sensor data notification to Telegram
        await sendSensorDataNotification(
            water_level,
            systemState.triggerLevel,
            systemState.alarmActive,
            node_id,
            wifi_rssi,
            sheetsResult
        );

        const processingTime = Date.now() - startTime;

        const responseData = {
            success: true,
            message: sheetsResult.success ? 'Data received and logged' : 'Data received, sheets logging failed',
            status: sheetsResult.success ? 'success' : 'partial_success',
            data: {
                water_level: water_level,
                alarm_status: systemState.alarmActive,
                trigger_level: systemState.triggerLevel,
                sheets_logged: sheetsResult.success,
                processing_time_ms: processingTime,
                server_time: new Date().toISOString(),
                connection_count: systemState.connectionCount,
                platform: systemState.deploymentInfo.platform
            }
        };

        if (sheetsResult.success) {
            responseData.data.row_number = sheetsResult.rowNumber;
            console.log(`✅ Complete success in ${processingTime}ms`);
        } else {
            responseData.data.sheets_error = sheetsResult.error;
            console.log(`⚠️ Partial success in ${processingTime}ms - sheets failed`);
        }

        res.json(responseData);
        console.log('=== END SENSOR DATA PROCESSING ===\n');

    } catch (error) {
        const processingTime = Date.now() - startTime;
        console.error('❌ Error processing sensor data:', error.message);
        console.error('🔍 Full error:', error);

        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message,
            processing_time_ms: processingTime,
            server_time: new Date().toISOString(),
            platform: systemState.deploymentInfo.platform
        });
    }
});

// Health check endpoint with comprehensive system info
app.get('/api/health', async (req, res) => {
    const uptime = Math.floor(process.uptime());

    const health = {
        server: 'running',
        timestamp: new Date().toISOString(),
        uptime_seconds: uptime,
        uptime_formatted: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m ${uptime%60}s`,
        server_start_time: systemState.serverStartTime.toISOString(),
        deployment: systemState.deploymentInfo,
        sheets_initialized: systemState.sheetsInitialized,
        telegram_bot: 'active',
        system: {
            last_sensor_reading: systemState.lastReading,
            current_water_level: systemState.currentWaterLevel,
            alarm_active: systemState.alarmActive,
            trigger_level: systemState.triggerLevel,
            connection_count: systemState.connectionCount,
            last_connection_time: systemState.lastConnectionTime,
            manual_override: systemState.manualOverride
        },
        config: {
            credentials_loaded: !!credentials,
            spreadsheet_id: spreadsheetId,
            service_account_email: credentials?.client_email,
            telegram_bot_configured: !!telegramToken,
            port: process.env.PORT || 3000,
            node_env: process.env.NODE_ENV || 'development'
        }
    };

    // Test sheets connection
    try {
        if (systemState.sheetsInitialized && doc) {
            await doc.loadInfo();
            health.sheets_connection = 'ok';
            health.sheets_title = doc.title;
            health.sheets_count = doc.sheetCount;
        } else {
            health.sheets_connection = 'not_initialized';
        }
    } catch (error) {
        health.sheets_connection = 'error';
        health.sheets_error = error.message;
    }

    res.json(health);
});

// Force reinitialize sheets
app.post('/api/sheets/reinit', async (req, res) => {
    try {
        console.log('🔄 Manual sheets reinitialization requested...');
        systemState.sheetsInitialized = false;
        await initializeSheets();

        if (systemState.sheetsInitialized) {
            res.json({
                success: true,
                message: 'Sheets reinitialized successfully',
                title: doc.title,
                sheet_count: doc.sheetCount,
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to reinitialize sheets',
                timestamp: new Date().toISOString()
            });
        }
    } catch (error) {
        console.error('❌ Manual reinit failed:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Get alarm status (for alarm node)
app.get('/api/alarm/status', (req, res) => {
    res.json({
        alarm_state: systemState.alarmActive ? 'on' : 'off',
        trigger_level: systemState.triggerLevel,
        manual_override: systemState.manualOverride,
        water_level: systemState.currentWaterLevel,
        sheets_status: systemState.sheetsInitialized ? 'ok' : 'error',
        server_time: new Date().toISOString(),
        alarm_start_time: systemState.alarmStartTime,
        platform: systemState.deploymentInfo.platform
    });
});

// Update alarm status (from alarm node)
app.post('/api/alarm/status', (req, res) => {
    const { alarm_state, timestamp } = req.body;
    console.log(`🔔 Alarm node status update: ${alarm_state} at ${timestamp}`);

    res.json({
        status: 'acknowledged',
        server_time: new Date().toISOString(),
        platform: systemState.deploymentInfo.platform
    });
});

// System info endpoint for debugging
app.get('/api/system', (req, res) => {
    res.json({
        deployment: systemState.deploymentInfo,
        environment_variables: {
            NODE_ENV: process.env.NODE_ENV,
            PORT: process.env.PORT,
            RENDER: !!process.env.RENDER,
            telegram_configured: !!process.env.TELEGRAM_BOT_TOKEN,
            spreadsheet_configured: !!process.env.SPREADSHEET_ID,
            google_credentials_configured: !!process.env.GOOGLE_CREDENTIALS
        },
        system: {
            uptime: process.uptime(),
            memory_usage: process.memoryUsage(),
            node_version: process.version,
            platform: process.platform
        },
        application_state: systemState
    });
});

// Telegram Bot Commands

// Start command
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const welcomeMessage = `🌊 Selamat datang di AWS (Automatic Water Level System)!\n\n` +
        `🚀 Platform: ${systemState.deploymentInfo.platform}\n` +
        `📋 Version: ${systemState.deploymentInfo.version}\n\n` +
        `Commands yang tersedia:\n` +
        `/status - Cek status sistem terkini\n` +
        `/set_trigger <value> - Set trigger level (cm)\n` +
        `/alarm_on - Manual alarm ON\n` +
        `/alarm_off - Manual alarm OFF\n` +
        `/history - Lihat data terakhir\n` +
        `/health - Cek kesehatan sistem\n` +
        `/info - Info deployment`;

    bot.sendMessage(chatId, welcomeMessage);
});

// Status command
bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    const lastReadingTime = systemState.lastReading ? 
        systemState.lastReading.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : 
        'Tidak ada data';
    
    const uptime = Math.floor(process.uptime());
    const uptimeHours = Math.floor(uptime / 3600);
    const uptimeMinutes = Math.floor((uptime % 3600) / 60);

    const statusMessage = `📊 STATUS SISTEM AWS\n\n` +
        `💧 Water Level: ${systemState.currentWaterLevel} cm\n` +
        `⚡ Trigger Level: ${systemState.triggerLevel} cm\n` +
        `🚨 Alarm: ${systemState.alarmActive ? 'ON' : 'OFF'}\n` +
        `🔧 Manual Override: ${systemState.manualOverride ? 'YES' : 'NO'}\n` +
        `📊 Sheets: ${systemState.sheetsInitialized ? 'Connected' : 'Error'}\n` +
        `🔗 Connections: ${systemState.connectionCount}\n` +
        `🚀 Platform: ${systemState.deploymentInfo.platform}\n` +
        `⏰ Server Uptime: ${uptimeHours}h ${uptimeMinutes}m\n` +
        `🕕 Last Reading: ${lastReadingTime}`;

    bot.sendMessage(chatId, statusMessage);
});

// Health command
bot.onText(/\/health/, async (msg) => {
    const chatId = msg.chat.id;
    const uptime = Math.floor(process.uptime());

    let healthMessage = `🔧 SISTEM HEALTH CHECK\n\n`;
    healthMessage += `🖥️ Server: Running\n`;
    healthMessage += `🚀 Platform: ${systemState.deploymentInfo.platform}\n`;
    healthMessage += `🌍 Environment: ${systemState.deploymentInfo.environment}\n`;
    healthMessage += `⏱️ Uptime: ${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m\n`;
    healthMessage += `📊 Sheets: ${systemState.sheetsInitialized ? '✅ Connected' : '❌ Error'}\n`;
    healthMessage += `📱 Bot: ✅ Active\n`;
    healthMessage += `🔗 Total Connections: ${systemState.connectionCount}\n`;

    if (systemState.lastConnectionTime) {
        healthMessage += `🕕 Last Connection: ${systemState.lastConnectionTime.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n`;
    }

    if (doc && systemState.sheetsInitialized) {
        try {
            await doc.loadInfo();
            healthMessage += `📄 Sheet Title: ${doc.title}\n`;
            healthMessage += `📋 Total Sheets: ${doc.sheetCount}\n`;
        } catch (error) {
            healthMessage += `📄 Sheet Error: ${error.message}\n`;
        }
    }

    bot.sendMessage(chatId, healthMessage);
});

// Info command - show deployment information
bot.onText(/\/info/, (msg) => {
    const chatId = msg.chat.id;
    const startTime = systemState.serverStartTime.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    const infoMessage = `ℹ️ DEPLOYMENT INFO\n\n` +
        `🚀 Platform: ${systemState.deploymentInfo.platform}\n` +
        `🌍 Environment: ${systemState.deploymentInfo.environment}\n` +
        `📋 Version: ${systemState.deploymentInfo.version}\n` +
        `🕕 Started: ${startTime}\n` +
        `📊 Node.js: ${process.version}\n` +
        `🔗 Total Requests: ${systemState.connectionCount}\n` +
        `💾 Memory Usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`;

    bot.sendMessage(chatId, infoMessage);
});

// Set trigger level
bot.onText(/\/set_trigger (\d+(?:\.\d+)?)/, (msg, match) => {
    const chatId = msg.chat.id;
    const newTriggerLevel = parseFloat(match[1]);

    if (newTriggerLevel > 0 && newTriggerLevel <= 200) {
        systemState.triggerLevel = newTriggerLevel;
        bot.sendMessage(chatId, `✅ Trigger level berhasil diset ke ${newTriggerLevel} cm`);
        console.log(`⚙️ Trigger level changed to: ${newTriggerLevel} cm via Telegram`);
    } else {
        bot.sendMessage(chatId, `❌ Trigger level tidak valid. Gunakan nilai 0-200 cm`);
    }
});

// Manual alarm on
bot.onText(/\/alarm_on/, (msg) => {
    const chatId = msg.chat.id;
    systemState.alarmActive = true;
    systemState.manualOverride = true;
    systemState.alarmStartTime = new Date();
    
    bot.sendMessage(chatId, `🚨 Alarm diaktifkan secara manual\n🚀 Platform: ${systemState.deploymentInfo.platform}`);
    console.log('🔧 Alarm manually activated via Telegram');

    // Set 4-minute timer (can be overridden by manual off)
    setTimeout(() => {
        if (systemState.alarmActive && systemState.manualOverride) {
            systemState.alarmActive = false;
            systemState.manualOverride = false;
            systemState.alarmStartTime = null;
            bot.sendMessage(chatId, '⏰ Alarm otomatis OFF setelah 4 menit');
        }
    }, 240000); // 4 minutes
});

// Manual alarm off
bot.onText(/\/alarm_off/, (msg) => {
    const chatId = msg.chat.id;
    systemState.alarmActive = false;
    systemState.manualOverride = false;
    systemState.alarmStartTime = null;
    
    bot.sendMessage(chatId, `✅ Alarm dimatikan secara manual\n🚀 Platform: ${systemState.deploymentInfo.platform}`);
    console.log('🔧 Alarm manually deactivated via Telegram');
});

// History command
bot.onText(/\/history/, (msg) => {
    const chatId = msg.chat.id;
    
    const historyMessage = `📈 DATA TERAKHIR\n\n` +
        `💧 Water Level: ${systemState.currentWaterLevel} cm\n` +
        `⚡ Trigger Level: ${systemState.triggerLevel} cm\n` +
        `🚨 Status Alarm: ${systemState.alarmActive ? 'AKTIF' : 'TIDAK AKTIF'}\n` +
        `📊 Google Sheets: ${systemState.sheetsInitialized ? 'Terhubung' : 'Error'}\n` +
        `🔗 Total Koneksi: ${systemState.connectionCount}\n` +
        `🚀 Platform: ${systemState.deploymentInfo.platform}\n` +
        `🕕 Waktu Bacaan: ${systemState.lastReading ? systemState.lastReading.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : 'Belum ada data'}`;

    bot.sendMessage(chatId, historyMessage);
});

// Error handling
bot.on('polling_error', (error) => {
    console.error('❌ Telegram polling error:', error.message);
});

// Handle process termination gracefully
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    cleanup();
});

process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT received, shutting down gracefully...');
    cleanup();
});

function cleanup() {
    console.log('📊 Final statistics:');
    console.log(`  - Platform: ${systemState.deploymentInfo.platform}`);
    console.log(`  - Total connections: ${systemState.connectionCount}`);
    console.log(`  - Uptime: ${Math.floor(process.uptime())} seconds`);
    console.log(`  - Last reading: ${systemState.lastReading}`);

    console.log('👋 Stopping Telegram bot...');
    bot.stopPolling()
        .then(() => {
            console.log('✅ Telegram bot stopped');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Error stopping bot:', error);
            process.exit(1);
        });
}

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        console.log('🚀 Starting AWS Server...');
        
        // Initialize sheets first
        await initializeSheets();

        // Start HTTP server - IMPORTANT: Bind to 0.0.0.0 for Render
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`\n🌟 === AWS SERVER STARTED SUCCESSFULLY ===`);
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`🌍 Platform: ${systemState.deploymentInfo.platform}`);
            console.log(`🔍 Environment: ${systemState.deploymentInfo.environment}`);
            console.log(`📋 Version: ${systemState.deploymentInfo.version}`);
            console.log('📱 Telegram bot is active');
            console.log(`📊 Google Sheets: ${systemState.sheetsInitialized ? '✅ Ready' : '❌ Error (will retry)'}`);
            
            if (process.env.RENDER) {
                console.log(`🌍 Your app is live at: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'your-app'}.onrender.com`);
                console.log(`🔗 Health check: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'your-app'}.onrender.com/api/health`);
                console.log(`📡 ESP32 endpoint: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'your-app'}.onrender.com/api/sensor/data`);
            } else {
                console.log(`🔗 Local health check: http://localhost:${PORT}/api/health`);
                console.log(`📡 Local sensor endpoint: http://localhost:${PORT}/api/sensor/data`);
            }
            
            console.log(`🌟 ========================================\n`);
        });

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();