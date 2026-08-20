# VFS Bot - Multi-Instance Cluster Mode

## Overview

The bot now supports running multiple instances simultaneously, each with its own Chrome profile and unique proxy IP.

## Cluster Architecture

- **1 Server**: Shared HTTP form server at `http://127.0.0.1:3847`
- **N Instances**: Multiple bot instances (default: 5), each running independently
- **Instance Isolation**: Each instance has:
  - Unique Chrome profile: `C:/vfs-bot-profile-1`, `C:/vfs-bot-profile-2`, etc.
  - Unique debugging port: 9222, 9223, 9224, etc.
  - Unique proxy IP (from `PROXY_URLS`, or an exclusive IP from `proxies.txt` in IP List mode)
  - Independent job queue

## Setup

### 1. Configure `.env`

```env
# Bright Data: each instance automatically gets a different IP.
# Using the {session} placeholder ensures sticky sessions per instance
PROXY_URLS=http://user-session-{session}:pass@host:port

# IP List: one proxy IP per line in proxies.txt, shared port/credentials here.
PROXY_PROVIDER=iplist
PROXY_LIST_FILE=proxies.txt
PROXY_LIST_PROTOCOL=http
PROXY_LIST_PORT=8080
PROXY_LIST_USERNAME=user
PROXY_LIST_PASSWORD=pass

# Optionally set BOT_INSTANCE_ID to override the auto-generated ID
# BOT_INSTANCE_ID=custom-id
```

> The number of instances is set from the setup form UI when you click Submit — no `.env` variable needed.

### 2. Usage

#### Development Mode

**Single Instance (original mode):**
```bash
npm run dev
```

**Cluster Mode (5 instances):**
```bash
npm run dev:cluster
```

#### Production Mode

**Single Instance:**
```bash
npm run build
npm start
```

**Cluster Mode:**
```bash
npm run build
npm start:cluster
```

Or use the batch file:
```bash
start-cluster.bat
```

### 3. Form UI

When in cluster mode, the form at `http://127.0.0.1:3847` will show an instance selector dropdown at the top:

```
┌─────────────────────────────┐
│ Bot Instance                │
│ Select instance (each uses  │
│ different IP)               │
│ ┌─────────────────────────┐ │
│ │ Instance 1            ▼ │ │
│ └─────────────────────────┘ │
└─────────────────────────────┘
```

Select which instance you want to submit the job to. Each instance runs independently with its own IP.

## How It Works

### Proxy IP Assignment

Each instance gets a unique IP based on its `BOT_INSTANCE_ID`:

1. Instance 1 → `BOT_INSTANCE_ID=1` → Proxy IP #1
2. Instance 2 → `BOT_INSTANCE_ID=2` → Proxy IP #2
3. Instance 3 → `BOT_INSTANCE_ID=3` → Proxy IP #3
4. ...and so on

How the IP is picked depends on the proxy source selected in the Monitor / Configure tab:

- **Bright Data** (`PROXY_PROVIDER=brightdata`) — a hash of the instance ID picks a line from `PROXY_URLS`, and the `{session}` placeholder is replaced with a stable session token derived from the instance ID.
- **IP List** (`PROXY_PROVIDER=iplist`) — every IP in `proxies.txt` (one per line, shared port/credentials from `PROXY_LIST_*` in `.env`) is claimed exclusively through `proxy-claims.json`, so instance 1 takes the first free IP, instance 2 the next, and no two running bots share an IP. Every Chrome launch or IP rotate releases the current IP into a cooldown (`PROXY_LIST_COOLDOWN_MIN`, default 20 minutes) and takes the next unused one. When the list runs out the pool wraps around rather than failing. Editing `proxies.txt` while bots run only moves the bots whose IP was removed — no Chrome or fleet restart.

### Process Architecture

```
┌──────────────────────────────┐
│  cluster.ts (Main Process)   │
│  - Starts form server        │
│  - Spawns 5 bot instances    │
└─────────┬────────────────────┘
          │
          ├─────> index.js (Instance 1, BOT_INSTANCE_ID=1, Port 9222, Profile-1)
          ├─────> index.js (Instance 2, BOT_INSTANCE_ID=2, Port 9223, Profile-2)
          ├─────> index.js (Instance 3, BOT_INSTANCE_ID=3, Port 9224, Profile-3)
          ├─────> index.js (Instance 4, BOT_INSTANCE_ID=4, Port 9225, Profile-4)
          └─────> index.js (Instance 5, BOT_INSTANCE_ID=5, Port 9226, Profile-5)
```

### Job Queue

Each instance has its own job queue. When you submit a form with "Instance 3" selected:

1. Form server receives the submission
2. Queues the job for Instance 3
3. Instance 3 processes it when ready
4. Other instances continue working independently

## Important Notes

### Chrome Window Management

**IMPORTANT**: When using proxies in cluster mode, all Chrome windows must be fully closed before starting the cluster. This ensures each instance can launch Chrome with proper proxy settings.

### Debugging Ports

Each instance uses a sequential debugging port:
- Instance 1: 9222
- Instance 2: 9223
- Instance 3: 9224
- etc.

These ports are automatically configured and should not conflict.

### Profile Directories

Each instance uses its own Chrome profile:
```
C:/vfs-bot-profile-1
C:/vfs-bot-profile-2
C:/vfs-bot-profile-3
...
```

This ensures complete isolation between instances (cookies, sessions, cache, etc.).

## Troubleshooting

### Port Conflicts

If you see "Address already in use" errors:
- Check if another process is using ports 9222-9227
- Close all Chrome instances
- Try again

### Proxy Not Working

If instances show the same IP:
1. Ensure `PROXY_URLS` is configured in `.env`
2. Close all Chrome windows before starting cluster
3. Check logs for "Proxy enabled" confirmation
4. Verify proxy format: `http://user-session-{session}:pass@host:port`

### Instance Not Processing Jobs

Check logs for:
- "Bot instance started in cluster mode" - confirms instance is running
- "Form submitted for instance N" - confirms form server received the job
- "Running bot cycle for instance N" - confirms instance is processing

## Migration from Single to Cluster

1. Your existing `.env` works as-is
2. Use `npm run dev:cluster` instead of `npm run dev`
3. Set the number of instances from the setup form UI and click Submit

No code changes needed - the bot detects cluster mode automatically.
