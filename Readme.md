# Render Steam ID Processing Service

A distributed Steam ID processing system designed to run on Render.com, providing Game Coordinator filtering capabilities with sophisticated rate limiting to avoid Steam bans.

## Overview

This service acts as a processing node in a distributed Steam ID filtering pipeline. It receives raw Steam IDs from third-party programs, filters them for uniqueness against a main database, processes them through the CS2 Game Coordinator for profile validation, and submits qualifying IDs back to the main server.

## Architecture

```
Third-party Program → Render Service → Main Server Database
                          ↓
                   [Uniqueness Check]
                          ↓
                   [GC Profile Filtering]
                          ↓
                   [Submit to Main Server]
```

### Workers

The service consists of three coordinated workers:

1. **Uniqueness Checker** - Validates Steam IDs against main database
2. **Filter Service** - CS2 Game Coordinator profile validation with human-like behavior
3. **Submitter** - Sends filtered IDs to main server processing queue

## Features

- **Human-like Rate Limiting**: Sophisticated timing patterns to avoid Steam detection
- **Automatic Reconnection**: Handles Steam/GC disconnections gracefully
- **Break System**: Scheduled breaks with randomized timing
- **Timeout Recovery**: Extended breaks after consecutive failures
- **Health Monitoring**: HTTP endpoints for service monitoring
- **Debug Tools**: File inspection and worker restart capabilities

## API Endpoints

### Production Endpoints

- `GET /health` - Service health check (for UptimeRobot)
- `GET /` - Basic service information
- `POST /api/add-harvested-ids/` - Receive Steam IDs from third-party programs

### Debug Endpoints

- `GET /debug/files` - Inspect contents of processing files
- `POST /debug/restart-filter` - Manually restart the Filter Service worker
- `POST /debug/clear-files` - Clear specific processing files

## Configuration

### Required Files

1. **config.json** - Main configuration file
2. **steamauth.maFile** - Steam 2FA authentication file
3. **package.json** - Node.js dependencies

### config.json Structure

```json
{
  "steam_username": "your_steam_username",
  "steam_password": "your_steam_password", 
  "tradebot_api_key": "your_tradebot_api_key",
  "link_harvester_api_key": "your_link_harvester_api_key",
  
  "uniqueness_check_api_url": "https://your-main-server.com/api/filter-unique-steamids/",
  "mark_processed_api_url": "https://your-main-server.com/api/mark-steamid-processed/",
  "api_endpoint": "https://your-main-server.com/api/add-steam-id-to-queue/",
  
  "uniqueness_checker": {
    "check_interval": 60,
    "request_timeout": 30,
    "max_retries": 3,
    "retry_delay": 5
  },
  
  "filter_service": {
    "processing_delay_min": 1.5,
    "processing_delay_max": 3.0,
    "login_to_game_delay_min": 15,
    "login_to_game_delay_max": 25,
    "empty_queue_delay": 10,
    "error_delay": 45,
    "max_retries": 3,
    "request_timeout": 20,
    "requests_before_break_min": 60,
    "requests_before_break_max": 160,
    "break_duration_min": 15,
    "break_duration_max": 45,
    "max_consecutive_timeouts": 5,
    "timeout_recovery_break": 300
  },
  
  "submitter": {
    "file_check_interval": 1,
    "api_timeout": 15,
    "api_retry_delay_min": 1,
    "api_retry_delay_max": 60,
    "api_max_immediate_retries": 3,
    "request_delay": 5
  }
}
```

### steamauth.maFile Structure

```json
{
  "shared_secret": "your_base64_shared_secret",
  "identity_secret": "your_identity_secret",
  "Session": {...},
  "SteamID": "76561198...",
  "account_name": "your_steam_username"
}
```

## Deployment

### Prerequisites

- Render.com account
- Dedicated Steam account with CS2 access
- Steam Mobile Authenticator (.maFile)
- API keys for main server communication

### Deploy Steps

1. **Create Render Web Service**
   - Connect your GitHub repository
   - Set build command: `npm install`
   - Set start command: `npm start`
   - Environment: Node.js

2. **Upload Configuration**
   - Add `config.json` with your credentials
   - Add `steamauth.maFile` with 2FA secrets
   - Ensure both files are in the project root

3. **Configure Monitoring**
   - Set up UptimeRobot to ping `/health` every 5 minutes
   - Prevents Render free plan from sleeping the service

### Environment Variables

The service reads all configuration from `config.json` - no environment variables needed.

## Usage

### Sending Steam IDs

```bash
curl -X POST https://your-render-service.onrender.com/api/add-harvested-ids/ \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_link_harvester_api_key" \
  -d '{
    "username1": ["76561199556731347", "76561199815475160"],
    "username2": ["76561199815475161"]
  }'
```

### Health Monitoring

```bash
curl https://your-render-service.onrender.com/health
```

Response:
```json
{
  "status": "healthy",
  "uptime": 3600,
  "workers": {
    "uniquenessChecker": true,
    "filterService": true,
    "filterServiceProcessing": true,
    "submitter": true
  },
  "stats": {
    "totalIdsReceived": 1250,
    "lastActivity": "2025-06-10T15:30:00.000Z"
  }
}
```

### Debugging

Check file contents:
```bash
curl https://your-render-service.onrender.com/debug/files
```

Restart Filter Service:
```bash
curl -X POST https://your-render-service.onrender.com/debug/restart-filter
```

Clear stuck files:
```bash
curl -X POST https://your-render-service.onrender.com/debug/clear-files \
  -H "Content-Type: application/json" \
  -d '{"file": "steam_ids_unique.json"}'
```

## Processing Flow

1. **Receive IDs**: Third-party program sends Steam IDs to `/api/add-harvested-ids/`
2. **Store Locally**: IDs saved to `steam_ids.json`
3. **Check Uniqueness**: Uniqueness Checker calls main server API to filter duplicates
4. **Save Unique**: Unique IDs saved to `steam_ids_unique.json`
5. **GC Filtering**: Filter Service processes IDs through CS2 Game Coordinator
6. **Profile Validation**: Checks medals, commendations, and other criteria
7. **Save Filtered**: Passing IDs saved to `steam_ids_filtered.json`
8. **Submit Results**: Submitter sends filtered IDs to main server queue
9. **Mark Processed**: All processed IDs marked in main database

## Rate Limiting

The service implements sophisticated anti-detection measures:

- **Human-like Delays**: 1.5-3 second randomized delays between requests
- **Scheduled Breaks**: 15-45 second breaks every 60-160 requests
- **Timeout Recovery**: 5-minute breaks after consecutive timeouts
- **Login Delays**: 15-25 second delays before launching CS2
- **Exponential Backoff**: Progressive delays on API failures

## File Management

### Processing Files

- `steam_ids.json` - Incoming Steam IDs from third-party programs
- `steam_ids_unique.json` - IDs that passed uniqueness check
- `steam_ids_filtered.json` - IDs that passed GC filtering

### File Lifecycle

Files are automatically managed:
- Previous file cleared when IDs migrate forward
- Failed IDs returned to queue for retry
- Successful IDs removed after submission

## Troubleshooting

### Common Issues

**Filter Service shows `filterServiceProcessing: false`**
- Steam login failed or GC disconnected
- Check Steam credentials and 2FA file
- Use `/debug/restart-filter` to reconnect

**Service keeps restarting**
- Likely 2FA authentication issues
- Ensure `.maFile` is valid and Steam account is dedicated
- Check for multiple login attempts on same account

**High failure rates**
- May be rate limited by Steam
- Service will automatically take recovery breaks
- Monitor `/health` for timeout patterns

**IDs getting stuck**
- Use `/debug/files` to inspect queue status
- Use `/debug/restart-filter` for connection issues
- Use `/debug/clear-files` for permanently stuck files

### Render.com Specific

**Service sleeping on free plan**
- Set up UptimeRobot monitoring on `/health`
- Ping every 5 minutes to keep service alive

**File preservation during restarts**
- Use "Restart service" to preserve files
- Avoid "Deploy" options which reset files to Git state

## Dependencies

- **express**: HTTP server for API endpoints
- **steam-user**: Steam client connection
- **steam-totp**: 2FA code generation
- **globaloffensive**: CS2 Game Coordinator interface
- **steamid**: Steam ID manipulation utilities

## Security Notes

- Use dedicated Steam account for this service
- Never share Steam credentials or .maFile
- API keys should be unique and rotated regularly
- Monitor for unusual login patterns
- Keep service URL private to prevent abuse

## Support

For issues related to:
- **Steam connection**: Check account status and 2FA setup
- **Rate limiting**: Monitor service logs for timeout patterns
- **API errors**: Verify main server connectivity and API keys
- **Render deployment**: Check Render dashboard for build/runtime errors