// main.js - Render Steam ID Processing Service
const fs = require('fs');
const path = require('path');
const express = require('express');
const UniquenessChecker = require('./workers/uniqueness-checker');
const FilterService = require('./workers/filter-service');
const Submitter = require('./workers/submitter');

// Configuration
const CONFIG = {
    PORT: process.env.PORT || 3000,
    CONFIG_PATH: path.join(__dirname, 'config.json'),
    
    // Startup delays (same as local main.js)
    FILTER_SERVICE_DELAY: 2000,    // 2 seconds
    SUBMITTER_DELAY: 4000,         // 4 seconds total
    
    // Required files
    REQUIRED_FILES: [
        'steam_ids.json',
        'steam_ids_unique.json', 
        'steam_ids_filtered.json'
    ]
};

// Initialize Express app
const app = express();
app.use(express.json({ limit: '10mb' }));

// Processing statistics for health endpoint
let serviceStats = {
    startTime: new Date(),
    workers: {
        uniquenessChecker: { running: false, startTime: null },
        filterService: { running: false, startTime: null },
        submitter: { running: false, startTime: null }
    },
    lastActivity: new Date(),
    totalIdsReceived: 0
};

// Ensure directories and files exist
function initializeEnvironment() {
    // Create required JSON files if they don't exist
    CONFIG.REQUIRED_FILES.forEach(filename => {
        const filepath = path.join(__dirname, filename);
        if (!fs.existsSync(filepath)) {
            console.log(`Creating empty ${filename}...`);
            fs.writeFileSync(filepath, '{}', 'utf8');
        }
    });
    
    // Check for required config file
    if (!fs.existsSync(CONFIG.CONFIG_PATH)) {
        console.error('ERROR: config.json not found!');
        console.error('Please create config.json with your Steam credentials and API keys.');
        process.exit(1);
    }
}

// Helper functions
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Main service class
class RenderSteamService {
    constructor() {
        this.workers = {
            uniquenessChecker: null,
            filterService: null,
            submitter: null
        };
        this.running = false;
        this.setupEventHandlers();
    }
    
    setupEventHandlers() {
        process.on('SIGINT', () => {
            console.log('Received SIGINT, shutting down gracefully...');
            this.shutdown();
        });
        
        process.on('SIGTERM', () => {
            console.log('Received SIGTERM, shutting down gracefully...');
            this.shutdown();
        });
        
        process.on('uncaughtException', (error) => {
            console.error(`Uncaught exception: ${error.message}`);
            // Don't exit on uncaught exceptions in production
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            console.error(`Unhandled rejection: ${reason}`);
            // Don't exit on unhandled rejections
        });
    }
    
    async start() {
        if (this.running) {
            console.log('Service is already running');
            return;
        }
        
        this.running = true;
        console.log('🚀 Starting Render Steam ID Processing Service');
        console.log('========================================================');
        
        try {
            // Initialize environment
            initializeEnvironment();
            
            // Start HTTP server first
            await this.startHttpServer();
            
            // Start workers in sequence
            await this.startWorkers();
            
            console.log('✅ All workers started successfully!');
            console.log('📡 Service ready to receive Steam IDs');
            
        } catch (error) {
            console.error(`Failed to start service: ${error.message}`);
            this.shutdown();
        }
    }
    
    async startHttpServer() {
        return new Promise((resolve) => {
            this.server = app.listen(CONFIG.PORT, () => {
                console.log(`🌐 HTTP server running on port ${CONFIG.PORT}`);
                console.log(`📊 Health check: /health`);
                console.log(`📥 API endpoint: /api/add-harvested-ids/`);
                resolve();
            });
        });
    }
    
    async startWorkers() {
        // 1. Start Uniqueness Checker immediately
        console.log('🔍 Starting Uniqueness Checker...');
        this.workers.uniquenessChecker = new UniquenessChecker();
        this.workers.uniquenessChecker.start();
        serviceStats.workers.uniquenessChecker.running = true;
        serviceStats.workers.uniquenessChecker.startTime = new Date();
        
        // 2. Start Filter Service after delay
        console.log(`⏳ Waiting ${CONFIG.FILTER_SERVICE_DELAY/1000}s before starting Filter Service...`);
        await delay(CONFIG.FILTER_SERVICE_DELAY);
        
        console.log('🎮 Starting Filter Service...');
        this.workers.filterService = new FilterService();
        this.workers.filterService.start();
        serviceStats.workers.filterService.running = true;
        serviceStats.workers.filterService.startTime = new Date();
        
        // 3. Start Submitter after additional delay
        const remainingDelay = CONFIG.SUBMITTER_DELAY - CONFIG.FILTER_SERVICE_DELAY;
        console.log(`⏳ Waiting ${remainingDelay/1000}s more before starting Submitter...`);
        await delay(remainingDelay);
        
        console.log('📤 Starting Submitter...');
        this.workers.submitter = new Submitter();
        this.workers.submitter.start();
        serviceStats.workers.submitter.running = true;
        serviceStats.workers.submitter.startTime = new Date();
    }
    
    shutdown() {
        if (!this.running) {
            return;
        }
        
        console.log('🛑 Shutting down service...');
        this.running = false;
        
        // Stop all workers
        Object.entries(this.workers).forEach(([name, worker]) => {
            if (worker && typeof worker.stop === 'function') {
                try {
                    console.log(`Stopping ${name}...`);
                    worker.stop();
                } catch (error) {
                    console.error(`Error stopping ${name}: ${error.message}`);
                }
            }
        });
        
        // Stop HTTP server
        if (this.server) {
            this.server.close();
        }
        
        console.log('Service stopped');
        
        // Exit after a short delay to allow cleanup
        setTimeout(() => {
            process.exit(0);
        }, 1000);
    }
    
    // Get service status for health endpoint
    getStatus() {
        return {
            status: 'healthy',
            uptime: Math.floor((Date.now() - serviceStats.startTime) / 1000),
            workers: {
                uniquenessChecker: this.workers.uniquenessChecker?.isRunning() || false,
                filterService: this.workers.filterService?.isRunning() || false,
                filterServiceProcessing: this.workers.filterService?.isProcessingActive?.() || false,
                submitter: this.workers.submitter?.isRunning() || false
            },
            stats: {
                totalIdsReceived: serviceStats.totalIdsReceived,
                lastActivity: serviceStats.lastActivity
            },
            memory: process.memoryUsage()
        };
    }
}

// API Endpoints
app.get('/health', (req, res) => {
    const status = steamService.getStatus();
    res.json(status);
});

app.get('/', (req, res) => {
    res.json({
        message: 'Render Steam ID Processing Service',
        status: 'running',
        uptime: Math.floor((Date.now() - serviceStats.startTime) / 1000),
        endpoints: {
            health: '/health',
            addIds: '/api/add-harvested-ids/'
        }
    });
});

// Debug endpoints for troubleshooting
app.get('/debug/files', (req, res) => {
    try {
        const files = ['steam_ids.json', 'steam_ids_unique.json', 'steam_ids_filtered.json'];
        const fileContents = {};
        
        files.forEach(filename => {
            try {
                const filepath = path.join(__dirname, filename);
                if (fs.existsSync(filepath)) {
                    const content = fs.readFileSync(filepath, 'utf8');
                    fileContents[filename] = {
                        exists: true,
                        content: content ? JSON.parse(content) : {},
                        size: Buffer.byteLength(content, 'utf8')
                    };
                } else {
                    fileContents[filename] = { exists: false };
                }
            } catch (err) {
                fileContents[filename] = { exists: true, error: err.message };
            }
        });
        
        res.json({
            timestamp: new Date().toISOString(),
            files: fileContents
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/debug/restart-filter', async (req, res) => {
    try {
        console.log('[DEBUG] Manual restart of Filter Service requested');
        
        if (steamService.workers.filterService) {
            console.log('[DEBUG] Stopping existing Filter Service...');
            steamService.workers.filterService.stop();
            await delay(2000); // Wait 2 seconds
        }
        
        console.log('[DEBUG] Starting new Filter Service...');
        const FilterService = require('./workers/filter-service');
        steamService.workers.filterService = new FilterService();
        steamService.workers.filterService.start();
        
        serviceStats.workers.filterService.running = true;
        serviceStats.workers.filterService.startTime = new Date();
        
        res.json({
            success: true,
            message: 'Filter Service restarted',
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error(`[DEBUG] Error restarting Filter Service: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post('/debug/clear-files', async (req, res) => {
    try {
        const { file } = req.body;
        const allowedFiles = ['steam_ids.json', 'steam_ids_unique.json', 'steam_ids_filtered.json'];
        
        if (!file || !allowedFiles.includes(file)) {
            return res.status(400).json({
                error: 'Invalid file. Allowed: ' + allowedFiles.join(', ')
            });
        }
        
        const filepath = path.join(__dirname, file);
        fs.writeFileSync(filepath, '{}', 'utf8');
        
        console.log(`[DEBUG] Cleared ${file}`);
        
        res.json({
            success: true,
            message: `Cleared ${file}`,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post('/api/add-harvested-ids/', async (req, res) => {
    try {
        // Simple API key validation (same as Django)
        const apiKey = req.headers['x-api-key'];
        
        // Load config to get API key
        const config = JSON.parse(fs.readFileSync(CONFIG.CONFIG_PATH, 'utf8'));
        if (!apiKey || apiKey !== config.link_harvester_api_key) {
            return res.status(401).json({ error: 'Invalid API key' });
        }
        
        const data = req.body;
        
        if (!data || typeof data !== 'object') {
            return res.status(400).json({
                error: 'Invalid JSON format. Expected object with username keys.'
            });
        }
        
        // Validate input data
        let totalIdsReceived = 0;
        for (const [username, steamIds] of Object.entries(data)) {
            if (!Array.isArray(steamIds)) {
                return res.status(400).json({
                    error: `Invalid format for user ${username}. Expected list of Steam IDs.`
                });
            }
            
            // Validate each Steam ID
            for (const steamId of steamIds) {
                const steamIdStr = String(steamId).trim();
                if (!steamIdStr.match(/^\d{17}$/)) {
                    return res.status(400).json({
                        error: `Invalid Steam ID format: ${steamIdStr}. Must be exactly 17 digits.`,
                        username: username
                    });
                }
            }
            
            totalIdsReceived += steamIds.length;
        }
        
        // Read existing steam_ids.json
        const steamIdsPath = path.join(__dirname, 'steam_ids.json');
        let existingData = {};
        
        try {
            const content = fs.readFileSync(steamIdsPath, 'utf8').trim();
            if (content) {
                existingData = JSON.parse(content);
            }
        } catch (err) {
            // File doesn't exist or is empty, start with empty object
            existingData = {};
        }
        
        // Merge new data with existing data
        for (const [username, steamIds] of Object.entries(data)) {
            const steamIdsStr = steamIds.map(id => String(id));
            
            if (existingData[username]) {
                // Combine with existing IDs, remove duplicates
                const existingIds = existingData[username].map(id => String(id));
                const combinedIds = [...new Set([...existingIds, ...steamIdsStr])];
                existingData[username] = combinedIds;
            } else {
                existingData[username] = steamIdsStr;
            }
        }
        
        // Write updated data back to file
        fs.writeFileSync(steamIdsPath, JSON.stringify(existingData, null, 2));
        
        // Update stats
        serviceStats.totalIdsReceived += totalIdsReceived;
        serviceStats.lastActivity = new Date();
        
        console.log(`📥 Received ${totalIdsReceived} Steam IDs from ${Object.keys(data).length} users`);
        
        res.json({
            success: true,
            message: 'Steam IDs successfully added',
            stats: {
                ids_received: totalIdsReceived,
                users_updated: Object.keys(data).length
            }
        });
        
    } catch (error) {
        console.error(`Error adding harvested Steam IDs: ${error.message}`);
        res.status(500).json({
            error: 'Internal server error'
        });
    }
});

// Initialize and start service
const steamService = new RenderSteamService();

// Start the service
steamService.start().catch(error => {
    console.error('Failed to start service:', error.message);
    process.exit(1);
});

module.exports = steamService;