// workers/submitter.js - Render version
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// Configuration
const CONFIG = {
    FILTERED_STEAMIDS_PATH: path.join(__dirname, '../steam_ids_filtered.json'),
    CONFIG_PATH: path.join(__dirname, '../config.json'),
    
    // Default configuration (can be overridden by config.json)
    FILE_CHECK_INTERVAL: 1000, // 1 second
    API_TIMEOUT: 15000, // 15 seconds
    API_RETRY_DELAY_MIN: 1000, // 1 second
    API_RETRY_DELAY_MAX: 60000, // 60 seconds
    API_MAX_IMMEDIATE_RETRIES: 3,
    REQUEST_DELAY: 5000, // 5 seconds between API calls
    API_ENDPOINT: null,
    API_KEY: null,
};

// Helper functions
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Main worker class
class Submitter {
    constructor() {
        this.config = this.loadConfig();
        this.running = false;
        this.lastRequestTime = 0;
        this.stats = {
            totalProcessed: 0,
            successful: 0,
            failed: 0,
            lastProcessedId: null,
            startTime: null
        };
    }

    loadConfig() {
        try {
            let config = { ...CONFIG }; // Start with defaults
            
            if (fs.existsSync(CONFIG.CONFIG_PATH)) {
                const userConfig = JSON.parse(fs.readFileSync(CONFIG.CONFIG_PATH, 'utf8'));
                
                // Load API key
                config.API_KEY = userConfig.tradebot_api_key;
                
                if (!config.API_KEY) {
                    throw new Error('tradebot_api_key is required in config.json');
                }
                
                // Override submitter settings if present
                if (userConfig.submitter) {
                    const sub = userConfig.submitter;
                    config.FILE_CHECK_INTERVAL = (sub.file_check_interval || CONFIG.FILE_CHECK_INTERVAL / 1000) * 1000;
                    config.API_TIMEOUT = (sub.api_timeout || CONFIG.API_TIMEOUT / 1000) * 1000;
                    config.API_RETRY_DELAY_MIN = (sub.api_retry_delay_min || CONFIG.API_RETRY_DELAY_MIN / 1000) * 1000;
                    config.API_RETRY_DELAY_MAX = (sub.api_retry_delay_max || CONFIG.API_RETRY_DELAY_MAX / 1000) * 1000;
                    config.API_MAX_IMMEDIATE_RETRIES = sub.api_max_immediate_retries || CONFIG.API_MAX_IMMEDIATE_RETRIES;
                    config.REQUEST_DELAY = (sub.request_delay || CONFIG.REQUEST_DELAY / 1000) * 1000;
                }
                
                // Load API endpoint from root config
                config.API_ENDPOINT = userConfig.api_endpoint || 'https://kuchababok.online/en/links/api/add-steam-id-to-queue/';
            } else {
                throw new Error('config.json not found');
            }
            
            return config;
        } catch (err) {
            console.error(`[SUBMITTER] Error loading config: ${err.message}`);
            throw err;
        }
    }

    start() {
        if (this.running) {
            console.log('[SUBMITTER] Worker is already running');
            return;
        }
        
        this.running = true;
        this.stats.startTime = new Date();
        
        console.log('[SUBMITTER] 📤 Starting Steam API Submission Service Worker');
        console.log(`[SUBMITTER] API Endpoint: ${this.config.API_ENDPOINT}`);
        console.log(`[SUBMITTER] File check interval: ${this.config.FILE_CHECK_INTERVAL}ms`);
        console.log(`[SUBMITTER] Request delay: ${this.config.REQUEST_DELAY}ms`);
        
        this.processLoop();
        console.log('[SUBMITTER] ✅ Worker started successfully');
    }

    async processLoop() {
        while (this.running) {
            try {
                await this.processPendingIDs();
                await delay(this.config.FILE_CHECK_INTERVAL);
            } catch (error) {
                console.error(`[SUBMITTER] ❌ Process loop error: ${error.message}`);
                await delay(this.config.FILE_CHECK_INTERVAL * 5); // Wait longer on errors
            }
        }
    }

    async processPendingIDs() {
        const pendingData = await this.getPendingIDs();
        
        if (!pendingData || Object.keys(pendingData).length === 0) {
            return; // No pending IDs, silent return
        }

        // Process one ID from the first user that has pending IDs
        for (const [username, steamIDs] of Object.entries(pendingData)) {
            if (steamIDs && steamIDs.length > 0) {
                const steamID = steamIDs[0];
                await this.processID(steamID, username);
                break; // Only process one ID per cycle
            }
        }
    }

    async getPendingIDs() {
        try {
            const fileContent = fs.readFileSync(this.config.FILTERED_STEAMIDS_PATH, 'utf8');
            if (!fileContent.trim()) return {};
            return JSON.parse(fileContent);
        } catch (err) {
            if (err.code !== 'ENOENT') { // Don't log if file doesn't exist
                console.error(`[SUBMITTER] Error reading filtered IDs file: ${err.message}`);
            }
            return {};
        }
    }

    async processID(steamID, username) {
        const startTime = Date.now();
        
        // Respect rate limiting
        const timeSinceLastRequest = Date.now() - this.lastRequestTime;
        if (timeSinceLastRequest < this.config.REQUEST_DELAY) {
            await delay(this.config.REQUEST_DELAY - timeSinceLastRequest);
        }

        let attempts = 0;
        let lastError = null;

        while (attempts < this.config.API_MAX_IMMEDIATE_RETRIES) {
            attempts++;
            
            try {
                const success = await this.submitToAPI(steamID, username);
                
                if (success) {
                    await this.removeFromPendingIDs(steamID, username);
                    const duration = Date.now() - startTime;
                    
                    this.stats.totalProcessed++;
                    this.stats.successful++;
                    this.stats.lastProcessedId = steamID;
                    
                    console.log(`[SUBMITTER] ✅ Successfully submitted ${steamID} for ${username} (${duration}ms)`);
                    this.lastRequestTime = Date.now();
                    return;
                }
            } catch (error) {
                lastError = error;
                
                // Handle 401 errors specially - log error but don't exit
                if (error.statusCode === 401) {
                    console.error(`[SUBMITTER] ❌ Authentication failed (401). Check API key in config.json.`);
                    // Don't continue trying this request, but don't exit the service
                    break;
                }
                
                console.error(`[SUBMITTER] Attempt ${attempts} failed for ${steamID}: ${error.message}`);
                
                if (attempts < this.config.API_MAX_IMMEDIATE_RETRIES) {
                    // Exponential backoff: 1s, 2s, 4s, etc.
                    const backoffDelay = Math.min(
                        this.config.API_RETRY_DELAY_MIN * Math.pow(2, attempts - 1),
                        this.config.API_RETRY_DELAY_MAX
                    );
                    console.log(`[SUBMITTER] ⏳ Retrying in ${backoffDelay}ms...`);
                    await delay(backoffDelay);
                }
            }
        }

        // All retries failed
        const duration = Date.now() - startTime;
        this.stats.totalProcessed++;
        this.stats.failed++;
        this.stats.lastProcessedId = steamID;
        
        console.error(`[SUBMITTER] ❌ Failed to submit ${steamID} after ${attempts} attempts (${duration}ms): ${lastError?.message}`);
        this.lastRequestTime = Date.now();
    }

    async submitToAPI(steamID, username) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({
                steam_id: steamID,
                username: username
            });

            const url = new URL(this.config.API_ENDPOINT);
            const options = {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'X-API-Key': this.config.API_KEY
                },
                timeout: this.config.API_TIMEOUT
            };

            const client = url.protocol === 'https:' ? https : http;
            const req = client.request(options, (res) => {
                let responseData = '';
                
                res.on('data', (chunk) => {
                    responseData += chunk;
                });
                
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        // Parse response to check for already_exists flag
                        try {
                            const response = JSON.parse(responseData);
                            if (response.already_exists) {
                                console.log(`[SUBMITTER] ℹ️ ${steamID} already exists in database`);
                            }
                        } catch (parseErr) {
                            // Response might not be JSON, that's okay
                        }
                        resolve(true);
                    } else {
                        const error = new Error(`HTTP ${res.statusCode}: ${responseData}`);
                        error.statusCode = res.statusCode;
                        error.responseData = responseData;
                        reject(error);
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.on('error', (err) => {
                reject(new Error(`Network error: ${err.message}`));
            });

            req.write(postData);
            req.end();
        });
    }

    async removeFromPendingIDs(steamID, username) {
        try {
            const fileContent = fs.readFileSync(this.config.FILTERED_STEAMIDS_PATH, 'utf8');
            let data = {};
            
            if (fileContent.trim()) {
                data = JSON.parse(fileContent);
            }
            
            if (data[username] && Array.isArray(data[username])) {
                const index = data[username].indexOf(steamID);
                if (index > -1) {
                    data[username].splice(index, 1);
                    
                    // Remove empty arrays
                    if (data[username].length === 0) {
                        delete data[username];
                    }
                    
                    fs.writeFileSync(this.config.FILTERED_STEAMIDS_PATH, JSON.stringify(data, null, 2));
                    console.log(`[SUBMITTER] 🗑️ Removed ${steamID} from pending queue for ${username}`);
                }
            }
        } catch (err) {
            console.error(`[SUBMITTER] Error removing ID from pending queue: ${err.message}`);
            throw err;
        }
    }

    stop() {
        if (!this.running) {
            return;
        }
        
        console.log('[SUBMITTER] 🛑 Stopping Steam API Submission Service Worker...');
        this.running = false;
        
        // Log final stats
        const runtime = this.stats.startTime ? Math.round((Date.now() - this.stats.startTime) / 1000) : 0;
        console.log(`[SUBMITTER] 📊 Final stats: ${this.stats.successful}/${this.stats.totalProcessed} successful (${runtime}s runtime)`);
        
        console.log('[SUBMITTER] ✅ Worker stopped');
    }

    isRunning() {
        return this.running;
    }

    getStats() {
        return {
            ...this.stats,
            runtime: this.stats.startTime ? Math.round((Date.now() - this.stats.startTime) / 1000) : 0
        };
    }
}

module.exports = Submitter;