// workers/uniqueness-checker.js - Render version
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Configuration
const CONFIG = {
    INPUT_FILE: path.join(__dirname, '../steam_ids.json'),
    OUTPUT_FILE: path.join(__dirname, '../steam_ids_unique.json'),
    CONFIG_PATH: path.join(__dirname, '../config.json'),
    
    // Default configuration (can be overridden by config.json)
    CHECK_INTERVAL: 60000,  // Check every minute (60 seconds)
    REQUEST_TIMEOUT: 30000, // 30 seconds timeout for API requests
    MAX_RETRIES: 3,         // Max retries for failed API calls
    RETRY_DELAY: 5000,      // 5 seconds between retries
    
    // Django API configuration (loaded from config)
    DJANGO_API_URL: null,
    API_KEY: null,
};

// Helper functions
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function fileExists(filePath) {
    try {
        return fs.existsSync(filePath);
    } catch (err) {
        return false;
    }
}

function readJsonFile(filePath) {
    try {
        if (!fileExists(filePath)) {
            return {};
        }
        
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (!content) {
            return {};
        }
        
        return JSON.parse(content);
    } catch (err) {
        console.error(`[UNIQUENESS] Error reading ${filePath}: ${err.message}`);
        return {};
    }
}

function writeJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error(`[UNIQUENESS] Error writing ${filePath}: ${err.message}`);
        return false;
    }
}

// API call function with retry logic
async function callDjangoAPI(steamIdsData, config, attempt = 1) {
    return new Promise((resolve, reject) => {
        const url = new URL(config.DJANGO_API_URL);
        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;
        
        const postData = JSON.stringify(steamIdsData);
        
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
            timeout: config.REQUEST_TIMEOUT
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

async function callDjangoAPIWithRetries(steamIdsData, config) {
    let lastError;
    
    for (let attempt = 1; attempt <= config.MAX_RETRIES; attempt++) {
        try {
            console.log(`[UNIQUENESS] Calling Django API (attempt ${attempt}/${config.MAX_RETRIES})...`);
            const response = await callDjangoAPI(steamIdsData, config, attempt);
            return response;
        } catch (err) {
            lastError = err;
            console.error(`[UNIQUENESS] API call attempt ${attempt} failed: ${err.message}`);
            
            if (attempt < config.MAX_RETRIES) {
                console.log(`[UNIQUENESS] Retrying in ${config.RETRY_DELAY/1000} seconds...`);
                await delay(config.RETRY_DELAY);
            }
        }
    }
    
    throw new Error(`All ${config.MAX_RETRIES} API attempts failed. Last error: ${lastError.message}`);
}

// Main processing function
async function processUniquenessCheck(config) {
    try {
        // Read input file
        const steamIdsData = readJsonFile(config.INPUT_FILE);
        
        // Check if there's any data to process
        const totalIds = Object.values(steamIdsData).reduce((sum, ids) => sum + (ids?.length || 0), 0);
        
        if (totalIds === 0) {
            // No logging when no data to avoid spam
            return;
        }
        
        console.log(`[UNIQUENESS] Processing ${totalIds} Steam IDs from ${Object.keys(steamIdsData).length} users`);
        
        // Call Django API to filter unique IDs
        const response = await callDjangoAPIWithRetries(steamIdsData, config);
        
        if (!response.success) {
            throw new Error(`API returned error: ${response.error || 'Unknown error'}`);
        }
        
        // Log statistics
        const stats = response.stats || {};
        console.log(`[UNIQUENESS] ✅ Completed: ${stats.total_input || 0} input, ${stats.unique_found || 0} unique, ${stats.already_exists || 0} duplicates`);
        
        // Write unique IDs to output file
        const uniqueIds = response.filtered_steamids || {};
        if (Object.keys(uniqueIds).length > 0) {
            if (writeJsonFile(config.OUTPUT_FILE, uniqueIds)) {
                console.log(`[UNIQUENESS] ✅ Written ${stats.unique_found || 0} unique Steam IDs to output file`);
            } else {
                throw new Error('Failed to write output file');
            }
        } else {
            console.log(`[UNIQUENESS] ℹ️ No unique Steam IDs found - all were duplicates`);
            // Create empty output file to signal completion
            writeJsonFile(config.OUTPUT_FILE, {});
        }
        
        // Clear the input file after successful processing
        if (writeJsonFile(config.INPUT_FILE, {})) {
            console.log(`[UNIQUENESS] ✅ Cleared input file after successful processing`);
        } else {
            console.error(`[UNIQUENESS] ⚠️ Failed to clear input file`);
        }
        
    } catch (error) {
        console.error(`[UNIQUENESS] ❌ Error during uniqueness check: ${error.message}`);
        
        // Don't clear input file on error - keep for retry
        console.log(`[UNIQUENESS] ℹ️ Input file preserved for retry due to error`);
    }
}

// Worker class
class UniquenessChecker {
    constructor() {
        this.running = false;
        this.intervalId = null;
        this.config = this.loadConfig();
    }
    
    loadConfig() {
        try {
            let config = { ...CONFIG }; // Start with defaults
            
            if (fs.existsSync(CONFIG.CONFIG_PATH)) {
                const userConfig = JSON.parse(fs.readFileSync(CONFIG.CONFIG_PATH, 'utf8'));
                
                // Override defaults with user configuration
                if (userConfig.uniqueness_checker) {
                    const uc = userConfig.uniqueness_checker;
                    config.CHECK_INTERVAL = (uc.check_interval || CONFIG.CHECK_INTERVAL / 1000) * 1000;
                    config.REQUEST_TIMEOUT = (uc.request_timeout || CONFIG.REQUEST_TIMEOUT / 1000) * 1000;
                    config.MAX_RETRIES = uc.max_retries || CONFIG.MAX_RETRIES;
                    config.RETRY_DELAY = (uc.retry_delay || CONFIG.RETRY_DELAY / 1000) * 1000;
                }
                
                // Load API settings from root config
                config.DJANGO_API_URL = userConfig.uniqueness_check_api_url || 'https://kuchababok.online/en/links/api/filter-unique-steamids/';
                config.API_KEY = userConfig.link_harvester_api_key;
                
                if (!config.API_KEY) {
                    throw new Error('link_harvester_api_key is required in config.json');
                }
            } else {
                throw new Error('config.json not found');
            }
            
            return config;
        } catch (err) {
            console.error(`[UNIQUENESS] Error loading config: ${err.message}`);
            throw err;
        }
    }
    
    start() {
        if (this.running) {
            console.log('[UNIQUENESS] Worker is already running');
            return;
        }
        
        this.running = true;
        console.log('[UNIQUENESS] 🔍 Starting Steam ID Uniqueness Check Worker');
        console.log(`[UNIQUENESS] Check interval: ${this.config.CHECK_INTERVAL/1000}s, API: ${this.config.DJANGO_API_URL}`);
        
        // Process immediately on start
        this.processImmediately();
        
        // Set up interval for periodic checks
        this.intervalId = setInterval(() => {
            this.processImmediately();
        }, this.config.CHECK_INTERVAL);
        
        console.log('[UNIQUENESS] ✅ Worker started successfully');
    }
    
    async processImmediately() {
        try {
            await processUniquenessCheck(this.config);
        } catch (error) {
            console.error(`[UNIQUENESS] ❌ Unexpected error in periodic check: ${error.message}`);
        }
    }
    
    stop() {
        if (!this.running) {
            return;
        }
        
        console.log('[UNIQUENESS] 🛑 Stopping Steam ID Uniqueness Check Worker...');
        this.running = false;
        
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        
        console.log('[UNIQUENESS] ✅ Worker stopped');
    }
    
    isRunning() {
        return this.running;
    }
}

module.exports = UniquenessChecker;