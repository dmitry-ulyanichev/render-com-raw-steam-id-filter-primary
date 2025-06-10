// workers/filter-service.js - Render version
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const GlobalOffensive = require('globaloffensive');
const SteamID = require('steamid');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Configuration - More human-like timings
const CONFIG = {
    STEAMIDS_PATH: path.join(__dirname, '../steam_ids_unique.json'),
    FILTERED_STEAMIDS_PATH: path.join(__dirname, '../steam_ids_filtered.json'),
    MAFILE_PATH: path.join(__dirname, '../steamauth.maFile'),
    CONFIG_PATH: path.join(__dirname, '../config.json'),
    
    // Django API configuration
    DJANGO_API_URL: null,
    API_KEY: null,
    
    // Human-like delays (defaults, can be overridden by config)
    PROCESSING_DELAY_MIN: 1500,     // 1.5 seconds minimum between requests
    PROCESSING_DELAY_MAX: 3000,    // 3 seconds maximum between requests
    LOGIN_TO_GAME_DELAY_MIN: 15000, // 15 seconds minimum after login
    LOGIN_TO_GAME_DELAY_MAX: 25000, // 25 seconds maximum after login
    
    EMPTY_QUEUE_DELAY: 10000,       // 10 seconds when queue is empty
    ERROR_DELAY: 45000,             // 45 seconds after errors
    MAX_RETRIES: 3,                 // Max retries for a single SteamID
    REQUEST_TIMEOUT: 20000,         // 20 seconds timeout for GC requests
    
    // Break system
    REQUESTS_BEFORE_BREAK_MIN: 60,  // Minimum requests before taking a break
    REQUESTS_BEFORE_BREAK_MAX: 160,  // Maximum requests before taking a break
    BREAK_DURATION_MIN: 15000,      // 15 seconds minimum break
    BREAK_DURATION_MAX: 45000,     // 45 seconds maximum break
    
    // Health monitoring
    MAX_CONSECUTIVE_TIMEOUTS: 5,    // Max timeouts before long break
    TIMEOUT_RECOVERY_BREAK: 300000, // 5 minutes break after too many timeouts
};

// Helper functions
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getRandomDelay(min, max) {
    return min + Math.random() * (max - min);
}

// Django API helper functions
async function markSteamIdProcessed(steamID, config) {
    return new Promise((resolve, reject) => {
        const url = new URL(config.DJANGO_API_URL);
        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;
        
        const postData = JSON.stringify({
            steam_id: steamID.toString()
        });
        
        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'X-API-Key': config.API_KEY
            },
            timeout: 10000
        };
        
        const req = httpModule.request(options, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    if (res.statusCode === 200) {
                        const response = JSON.parse(data);
                        resolve(response);
                    } else {
                        reject(new Error(`API returned status ${res.statusCode}: ${data}`));
                    }
                } catch (err) {
                    reject(new Error(`Failed to parse API response: ${err.message}`));
                }
            });
        });
        
        req.on('error', (err) => {
            reject(new Error(`API request failed: ${err.message}`));
        });
        
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('API request timeout'));
        });
        
        req.write(postData);
        req.end();
    });
}

async function markSteamIdProcessedWithRetries(steamID, config, maxRetries = 3) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await markSteamIdProcessed(steamID, config);
            
            if (response.success) {
                if (response.created) {
                    console.log(`[FILTER] ✅ Marked ${steamID} as processed in database`);
                } else {
                    console.log(`[FILTER] ℹ️ ${steamID} was already marked as processed`);
                }
                return true;
            } else {
                throw new Error(response.error || 'Unknown API error');
            }
        } catch (err) {
            lastError = err;
            console.error(`[FILTER] Failed to mark ${steamID} as processed (attempt ${attempt}): ${err.message}`);
            
            if (attempt < maxRetries) {
                await delay(2000);
            }
        }
    }
    
    console.error(`[FILTER] ❌ Failed to mark ${steamID} as processed after ${maxRetries} attempts: ${lastError.message}`);
    return false;
}

// Main worker class
class FilterService {
    constructor() {
        this.steamClient = new SteamUser();
        this.csgo = new GlobalOffensive(this.steamClient);
        this.config = this.loadConfig();
        this.maFile = this.loadMaFile();
        this.running = false;
        this.processingActive = false;
        this.currentSteamID = null;
        this.setupEventHandlers();
        this.failureStats = {};
        
        // Human-like behavior tracking
        this.requestCount = 0;
        this.lastBreakTime = Date.now();
        this.consecutiveTimeouts = 0;
        this.lastSuccessTime = Date.now();
        this.nextBreakAfter = this.calculateNextBreakPoint();
    }

    loadConfig() {
        try {
            let config = { ...CONFIG }; // Start with defaults
            
            if (fs.existsSync(CONFIG.CONFIG_PATH)) {
                const userConfig = JSON.parse(fs.readFileSync(CONFIG.CONFIG_PATH, 'utf8'));
                
                // Load Steam credentials
                config.steam_username = userConfig.steam_username;
                config.steam_password = userConfig.steam_password;
                
                if (!config.steam_username || !config.steam_password) {
                    throw new Error('steam_username and steam_password are required in config.json');
                }
                
                // Override filter service settings if present
                if (userConfig.filter_service) {
                    const fs = userConfig.filter_service;
                    config.PROCESSING_DELAY_MIN = (fs.processing_delay_min || CONFIG.PROCESSING_DELAY_MIN / 1000) * 1000;
                    config.PROCESSING_DELAY_MAX = (fs.processing_delay_max || CONFIG.PROCESSING_DELAY_MAX / 1000) * 1000;
                    config.LOGIN_TO_GAME_DELAY_MIN = (fs.login_to_game_delay_min || CONFIG.LOGIN_TO_GAME_DELAY_MIN / 1000) * 1000;
                    config.LOGIN_TO_GAME_DELAY_MAX = (fs.login_to_game_delay_max || CONFIG.LOGIN_TO_GAME_DELAY_MAX / 1000) * 1000;
                    config.EMPTY_QUEUE_DELAY = (fs.empty_queue_delay || CONFIG.EMPTY_QUEUE_DELAY / 1000) * 1000;
                    config.ERROR_DELAY = (fs.error_delay || CONFIG.ERROR_DELAY / 1000) * 1000;
                    config.MAX_RETRIES = fs.max_retries || CONFIG.MAX_RETRIES;
                    config.REQUEST_TIMEOUT = (fs.request_timeout || CONFIG.REQUEST_TIMEOUT / 1000) * 1000;
                    config.REQUESTS_BEFORE_BREAK_MIN = fs.requests_before_break_min || CONFIG.REQUESTS_BEFORE_BREAK_MIN;
                    config.REQUESTS_BEFORE_BREAK_MAX = fs.requests_before_break_max || CONFIG.REQUESTS_BEFORE_BREAK_MAX;
                    config.BREAK_DURATION_MIN = (fs.break_duration_min || CONFIG.BREAK_DURATION_MIN / 1000) * 1000;
                    config.BREAK_DURATION_MAX = (fs.break_duration_max || CONFIG.BREAK_DURATION_MAX / 1000) * 1000;
                    config.MAX_CONSECUTIVE_TIMEOUTS = fs.max_consecutive_timeouts || CONFIG.MAX_CONSECUTIVE_TIMEOUTS;
                    config.TIMEOUT_RECOVERY_BREAK = (fs.timeout_recovery_break || CONFIG.TIMEOUT_RECOVERY_BREAK / 1000) * 1000;
                }
                
                // Load API settings from root config
                config.DJANGO_API_URL = userConfig.mark_processed_api_url || 'https://kuchababok.online/en/links/api/mark-steamid-processed/';
                config.API_KEY = userConfig.link_harvester_api_key;
                
                if (!config.API_KEY) {
                    throw new Error('link_harvester_api_key is required in config.json');
                }
            } else {
                throw new Error('config.json not found');
            }
            
            return config;
        } catch (err) {
            console.error(`[FILTER] Error loading config: ${err.message}`);
            throw err;
        }
    }

    loadMaFile() {
        try {
            if (fs.existsSync(CONFIG.MAFILE_PATH)) {
                return JSON.parse(fs.readFileSync(CONFIG.MAFILE_PATH, 'utf8'));
            }
            console.log('[FILTER] ⚠️ steamauth.maFile not found - 2FA codes will not be available');
            return null;
        } catch (err) {
            console.error(`[FILTER] Error loading .maFile: ${err.message}`);
            return null;
        }
    }

    generateAuthCode() {
        if (this.maFile?.shared_secret) {
            try {
                return SteamTotp.generateAuthCode(this.maFile.shared_secret);
            } catch (err) {
                console.error(`[FILTER] Error generating auth code: ${err.message}`);
            }
        }
        return null;
    }

    calculateNextBreakPoint() {
        return this.config.REQUESTS_BEFORE_BREAK_MIN + 
               Math.floor(Math.random() * (this.config.REQUESTS_BEFORE_BREAK_MAX - this.config.REQUESTS_BEFORE_BREAK_MIN));
    }

    setupEventHandlers() {
        this.steamClient.on('error', (err) => {
            console.error(`[FILTER] Steam error: ${err.message}`);
            this.reconnect();
        });

        this.steamClient.on('loggedOn', () => {
            console.log('[FILTER] ✅ Logged into Steam! Waiting before launching CS2...');
            this.steamClient.setPersona(SteamUser.EPersonaState.Online);
            
            const gameDelay = getRandomDelay(this.config.LOGIN_TO_GAME_DELAY_MIN, this.config.LOGIN_TO_GAME_DELAY_MAX);
            console.log(`[FILTER] ⏳ Waiting ${Math.round(gameDelay/1000)} seconds before launching CS2...`);
            
            setTimeout(() => {
                console.log('[FILTER] 🎮 Launching CS2...');
                this.steamClient.gamesPlayed([730]);
            }, gameDelay);
        });

        this.csgo.on('connectedToGC', () => {
            console.log('[FILTER] ✅ Connected to CS2 Game Coordinator!');
            this.consecutiveTimeouts = 0;
            this.startProcessing();
        });

        this.csgo.on('disconnectedFromGC', (reason) => {
            console.error(`[FILTER] Disconnected from GC: ${reason}. Reconnecting...`);
            this.processingActive = false;
            this.reconnectToGC();
        });
    }

    async reconnect() {
        console.log('[FILTER] 🔄 Attempting to reconnect to Steam...');
        try {
            this.processingActive = false;
            await this.steamClient.logOff();
            await delay(5000);
            this.login();
        } catch (err) {
            console.error(`[FILTER] Reconnect failed: ${err.message}. Retrying in 30 seconds...`);
            await delay(30000);
            this.reconnect();
        }
    }

    reconnectToGC() {
        if (this.steamClient.steamID) {
            console.log('[FILTER] 🔄 Attempting to reconnect to GC...');
            setTimeout(() => {
                this.steamClient.gamesPlayed([730]);
            }, 5000);
        }
    }

    login() {
        const loginOptions = {
            accountName: this.config.steam_username,
            password: this.config.steam_password
        };

        const authCode = this.generateAuthCode();
        if (authCode) {
            loginOptions.twoFactorCode = authCode;
        }

        console.log(`[FILTER] 🔐 Logging into Steam as ${this.config.steam_username}...`);
        this.steamClient.logOn(loginOptions);
    }

    start() {
        if (this.running) {
            console.log('[FILTER] Worker is already running');
            return;
        }
        
        this.running = true;
        console.log('[FILTER] 🎮 Starting Steam ID Filter Service Worker');
        console.log(`[FILTER] Delays: ${this.config.PROCESSING_DELAY_MIN/1000}-${this.config.PROCESSING_DELAY_MAX/1000}s, breaks every ${this.config.REQUESTS_BEFORE_BREAK_MIN}-${this.config.REQUESTS_BEFORE_BREAK_MAX} requests`);
        console.log(`[FILTER] Django API: ${this.config.DJANGO_API_URL}`);
        
        this.login();
    }

    startProcessing() {
        if (this.processingActive) return;
        this.processingActive = true;
        console.log('[FILTER] 🚀 Starting to process Steam IDs with human-like behavior...');
        this.processQueue();
    }

    async processQueue() {
        while (this.running && this.processingActive) {
            try {
                // Check if we need to take a break
                if (this.requestCount >= this.nextBreakAfter) {
                    await this.takeScheduledBreak();
                }

                // Check for timeout recovery break
                if (this.consecutiveTimeouts >= this.config.MAX_CONSECUTIVE_TIMEOUTS) {
                    await this.takeTimeoutRecoveryBreak();
                }

                const result = await this.getNextSteamID();
                if (!result) {
                    await delay(this.config.EMPTY_QUEUE_DELAY);
                    continue;
                }
        
                const { steamID, username } = result;
                this.currentSteamID = { steamID, username };
                
                const processResult = await this.processSteamIDWithRetries(steamID, this.config.MAX_RETRIES);
        
                if (!processResult.success) {
                    await this.returnToQueue(steamID, username);
                    console.error(`[FILTER] ❌ Returned ${steamID} to queue after ${this.config.MAX_RETRIES} failures`);
                    
                    if (!this.failureStats[steamID]) {
                        this.failureStats[steamID] = { count: 0, errors: [] };
                    }
                    this.failureStats[steamID].count++;
                    this.failureStats[steamID].errors.push(processResult.error.message);
                    
                    if (processResult.error.message.includes('Timeout')) {
                        this.consecutiveTimeouts++;
                    }
                    
                    if (this.failureStats[steamID].count % 5 === 0) {
                        console.error(`[FILTER] ⚠️ ${steamID}: Total failures: ${this.failureStats[steamID].count}`);
                    }
                } else if (processResult.passedChecks) {
                    await this.addToFilteredIDs(steamID, username);
                    this.consecutiveTimeouts = 0;
                    this.lastSuccessTime = Date.now();
                }
                
                this.currentSteamID = null;
                this.requestCount++;
        
                const processingDelay = getRandomDelay(this.config.PROCESSING_DELAY_MIN, this.config.PROCESSING_DELAY_MAX);
                console.log(`[FILTER] ⏳ Waiting ${Math.round(processingDelay/1000)}s before next request...`);
                await delay(processingDelay);
                
            } catch (error) {
                console.error(`[FILTER] ❌ Queue error: ${error.message}`);
                if (this.currentSteamID) {
                    await this.returnToQueue(this.currentSteamID.steamID, this.currentSteamID.username);
                }
                await delay(this.config.ERROR_DELAY);
            }
        }
    }

    async takeScheduledBreak() {
        const breakDuration = getRandomDelay(this.config.BREAK_DURATION_MIN, this.config.BREAK_DURATION_MAX);
        console.log(`[FILTER] ☕ Taking scheduled break after ${this.requestCount} requests for ${Math.round(breakDuration/1000)} seconds`);
        
        await delay(breakDuration);
        
        this.lastBreakTime = Date.now();
        this.nextBreakAfter = this.requestCount + this.calculateNextBreakPoint();
        console.log('[FILTER] ✅ Break completed, resuming processing...');
    }

    async takeTimeoutRecoveryBreak() {
        console.error(`[FILTER] 🛑 Taking timeout recovery break after ${this.consecutiveTimeouts} consecutive timeouts`);
        await delay(this.config.TIMEOUT_RECOVERY_BREAK);
        this.consecutiveTimeouts = 0;
        console.log('[FILTER] ✅ Timeout recovery break completed');
    }

    async getNextSteamID() {
        try {
            const data = JSON.parse(fs.readFileSync(this.config.STEAMIDS_PATH, 'utf8'));
            
            for (const [username, steamIDs] of Object.entries(data)) {
                if (steamIDs && steamIDs.length > 0) {
                    const nextID = steamIDs.shift().toString();
                    
                    if (steamIDs.length === 0) {
                        delete data[username];
                    }
                    
                    fs.writeFileSync(this.config.STEAMIDS_PATH, JSON.stringify(data, null, 2));
                    return { steamID: nextID, username: username };
                }
            }
            
            return null;
        } catch (err) {
            console.error(`[FILTER] Error reading Steam IDs file: ${err.message}`);
            return null;
        }
    }

    async returnToQueue(steamID, username) {
        try {
            const data = JSON.parse(fs.readFileSync(this.config.STEAMIDS_PATH, 'utf8'));
            
            if (!data[username]) {
                data[username] = [];
            }
            
            data[username].unshift(steamID.toString());
            fs.writeFileSync(this.config.STEAMIDS_PATH, JSON.stringify(data, null, 2));
            console.log(`[FILTER] 🔄 Returned ${steamID} to processing queue for user ${username}`);
        } catch (err) {
            console.error(`[FILTER] Error returning ID to queue: ${err.message}`);
        }
    }

    async addToFilteredIDs(steamID, username) {
        try {
            let filteredData = {};
            if (fs.existsSync(this.config.FILTERED_STEAMIDS_PATH)) {
                try {
                    const fileContent = fs.readFileSync(this.config.FILTERED_STEAMIDS_PATH, 'utf8');
                    if (fileContent.trim()) {
                        filteredData = JSON.parse(fileContent);
                    }
                } catch (err) {
                    console.error(`[FILTER] Error reading filtered IDs file, starting fresh: ${err.message}`);
                    filteredData = {};
                }
            }
            
            if (!filteredData[username]) {
                filteredData[username] = [];
            }
            
            const steamIDStr = steamID.toString();
            
            if (!filteredData[username].includes(steamIDStr)) {
                filteredData[username].push(steamIDStr);
                fs.writeFileSync(this.config.FILTERED_STEAMIDS_PATH, JSON.stringify(filteredData, null, 2));
                console.log(`[FILTER] ✅ Added ${steamID} to filtered IDs for user ${username}`);
            } else {
                console.log(`[FILTER] ℹ️ Steam ID ${steamID} already exists for user ${username}`);
            }
        } catch (err) {
            console.error(`[FILTER] Error adding to filtered IDs: ${err.message}`);
        }
    }

    async processSteamIDWithRetries(steamID64, maxRetries) {
        let attempts = 0;
        let lastError = null;
        let processResult = null;

        while (attempts < maxRetries) {
            attempts++;
            try {
                const result = await this.fetchAndCheckProfile(steamID64);
                processResult = { success: true, ...result };
                break;
            } catch (error) {
                lastError = error;
                console.error(`[FILTER] Attempt ${attempts} failed for ${steamID64}: ${error.message}`);
                if (attempts < maxRetries) {
                    await delay(this.config.ERROR_DELAY);
                }
            }
        }

        if (!processResult) {
            processResult = { success: false, error: lastError };
        }

        try {
            await markSteamIdProcessedWithRetries(steamID64, this.config);
        } catch (err) {
            console.error(`[FILTER] ⚠️ Could not mark ${steamID64} as processed in database: ${err.message}`);
        }

        return processResult;
    }

    fetchAndCheckProfile(steamID64) {
        return new Promise((resolve, reject) => {
            const steamIDObj = new SteamID(steamID64.toString());
    
            const timeout = setTimeout(() => {
                this.consecutiveTimeouts++;
                reject(new Error(`Timeout fetching profile for ${steamID64}`));
            }, this.config.REQUEST_TIMEOUT);
    
            this.csgo.requestPlayersProfile(steamIDObj, (profile) => {
                clearTimeout(timeout);
                this.consecutiveTimeouts = 0;
                try {
                    const result = this.checkProfile(steamID64, profile);
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    checkProfile(steamID64, profile) {
        if (!profile) {
            throw new Error('No profile data received');
        }

        const medals = profile.medals?.display_items_defidx || [];
        const commend = profile.commendation || {};
        const totalCommendations =
            (commend.cmd_friendly || 0) +
            (commend.cmd_teaching || 0) +
            (commend.cmd_leader || 0);

        const unwantedMedals = new Set([
            4960, 6111, 6112, 6123, 6126, 6129, 4918, 4555, 4759, 6101, 4687,
            6113, 6106, 6125, 4886, 4853, 4703, 4552, 960, 4959, 4762, 4919,
            4828, 4800, 4761, 4626, 4986, 4873, 6127, 6128, 4799, 4702, 909,
            4550, 6105, 4798, 4553, 4760, 4958, 6114, 4884, 4701, 4700, 6124,
            4885, 6130, 4690, 6115, 4691, 6131, 4887, 935, 912, 908, 902, 4552, 968,
            952, 946, 6034, 6117, 6116, 6120, 6109, 6104, 6108, 6118, 4623, 4851
        ]);

        let passed = true;
        let filterReason = null;

        if (totalCommendations >= 100) {
            passed = false;
            filterReason = `commendations ≥ 100 (${totalCommendations})`;
        } else if (!medals.includes(874)) {
            passed = false;
            filterReason = "missing medal 874";
        } else if (medals.length < 3) {
            passed = false;
            filterReason = `less than 3 medals (has ${medals.length})`;
        } else if (medals.find(m => unwantedMedals.has(m)) !== undefined) {
            const firstUnwanted = medals.find(m => unwantedMedals.has(m));
            passed = false;
            filterReason = `has unwanted medal: ${firstUnwanted}`;
        }

        const resultMessage = passed ? 
            `✅ ${steamID64} - Passed filters` : 
            `❌ ${steamID64} - Failed (${filterReason})`;
        
        console.log(`[FILTER] ${resultMessage}`);

        return {
            passedChecks: passed,
            profileData: {
                account_id: profile.account_id,
                steam_id: steamID64,
                commendations: commend,
                medals: medals,
                timestamp: new Date().toISOString()
            }
        };
    }

    stop() {
        if (!this.running) {
            return;
        }
        
        console.log('[FILTER] 🛑 Stopping Steam ID Filter Service Worker...');
        this.running = false;
        this.processingActive = false;
        
        if (this.currentSteamID) {
            console.log(`[FILTER] 🔄 Shutdown detected, returning ${this.currentSteamID.steamID} to queue`);
            this.returnToQueue(this.currentSteamID.steamID, this.currentSteamID.username)
                .catch(err => console.error(`[FILTER] Failed to return ID on shutdown: ${err.message}`));
        }
        
        this.steamClient.logOff();
        console.log('[FILTER] ✅ Worker stopped');
    }

    isRunning() {
        return this.running && this.processingActive;
    }
}

module.exports = FilterService;