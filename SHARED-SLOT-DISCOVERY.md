# Shared Slot Discovery

## Overview

When running multiple instances, **any instance finding a slot triggers ALL instances** to stop polling and proceed to booking.

This ensures all 5 instances can attempt to book the same slot, increasing success chances.

## How It Works

### Shared State File

**Location:** `slot-state.json` (in bot root directory)

**Created when:** Any instance finds a slot

**Contains:**
```json
{
  "found": true,
  "foundBy": 3,
  "timestamp": 1710123456789,
  "slot": {
    "id": "12345",
    "center": "HYD",
    "date": "2024-03-15",
    "time": "10:00"
  },
  "centerCode": "HYD",
  "visaCategoryCode": "Busi"
}
```

**Important:** The file includes `centerCode` and `visaCategoryCode` from the instance that found the slot. **All instances will use these values** when booking, ensuring everyone books for the same center and visa category.

### Polling Behavior

**Each instance polls independently with random intervals:**

```
Instance 1: Poll... wait 35s... Poll... wait 22s... Poll...
Instance 2: Poll... wait 48s... Poll... wait 41s... Poll...
Instance 3: Poll... wait 19s... Poll... [SLOT FOUND!] → Writes slot-state.json
Instance 4: Poll... [Checks file] → Slot found by #3! → Stops polling
Instance 5: Poll... [Checks file] → Slot found by #3! → Stops polling
```

**Timeline:**
1. All 5 instances start polling (with random delays)
2. Instance 3 finds a slot at 10:23:15
3. Instance 3 writes `slot-state.json`
4. Instance 1 checks file before next poll → Sees slot found → Stops
5. Instance 2 checks file before next poll → Sees slot found → Stops
6. Instance 4 checks file before next poll → Sees slot found → Stops
7. Instance 5 checks file before next poll → Sees slot found → Stops
8. **All 5 instances proceed to booking chain**

### Booking Chain (All Instances)

Once slot is found, **all instances** proceed with **the same center and visa category**:

```
Instance 3 found slot for: centerCode=HYD, visaCategoryCode=Busi

All instances now use HYD + Busi:
Instance 1: Save Applicants (HYD, Busi) → Calendar → Timeslot → Fees → Schedule → Payment
Instance 2: Save Applicants (HYD, Busi) → Calendar → Timeslot → Fees → Schedule → Payment
Instance 3: Save Applicants (HYD, Busi) → Calendar → Timeslot → Fees → Schedule → Payment
Instance 4: Save Applicants (HYD, Busi) → Calendar → Timeslot → Fees → Schedule → Payment
Instance 5: Save Applicants (HYD, Busi) → Calendar → Timeslot → Fees → Schedule → Payment
```

All run **simultaneously** with:
- **Same centerCode** (from founder instance)
- **Same visaCategoryCode** (from founder instance)
- Different login credentials (per instance)
- Different applicant details (per instance)
- Different IP addresses (per instance)

## Benefits

✓ **First to find wins** - Any instance can trigger the booking
✓ **All instances book** - Maximizes success rate
✓ **No coordination delay** - File-based broadcast is instant
✓ **Race condition handled** - All instances compete fairly for the slot
✓ **Parallel booking** - 5 simultaneous booking attempts

## State Management

### Automatic Clear
- `slot-state.json` is automatically deleted when you click "Submit & Run All Instances"
- Fresh start for each submission

### Manual Clear
If needed, you can manually delete the file:
```bash
rm slot-state.json   # Linux/Mac
del slot-state.json  # Windows
```

### State Persistence
- The file persists across crashes (by design)
- If bot crashes during booking, file remains
- Next run will see old slot and proceed to booking
- Delete file if you want fresh polling

## Example Scenario

**Setup:**
- 5 instances with random poll intervals (20-60s)
- All start polling at slightly different times due to post-login random delay

**Scenario:**
```
T+0s:  All instances start (staggered by 0-30s random delay)
T+35s: Instance 1 polls → No slot
T+42s: Instance 2 polls → No slot
T+48s: Instance 5 polls → No slot
T+55s: Instance 1 polls again → No slot
T+63s: Instance 3 polls → SLOT FOUND! 🎉
       → Writes slot-state.json
       → Proceeds to booking
T+64s: Instance 4 about to poll → Checks file → Slot found by #3!
       → Skips polling
       → Proceeds to booking
T+67s: Instance 2 about to poll → Checks file → Slot found by #3!
       → Skips polling
       → Proceeds to booking
T+71s: Instance 1 about to poll → Checks file → Slot found by #3!
       → Skips polling
       → Proceeds to booking
T+78s: Instance 5 about to poll → Checks file → Slot found by #3!
       → Skips polling
       → Proceeds to booking

Result: All 5 instances now booking the same slot in parallel!
```

## Logs

**Instance that finds slot:**
```
[Instance 3] Slot found by this instance — broadcasting to all instances
```

**Other instances:**
```
[Instance 1] Slot found by another instance (foundBy: 3) — stopping poll loop and proceeding to booking
[Instance 2] Slot found by another instance (foundBy: 3) — stopping poll loop and proceeding to booking
[Instance 4] Slot found by another instance (foundBy: 3) — stopping poll loop and proceeding to booking
[Instance 5] Slot found by another instance (foundBy: 3) — stopping poll loop and proceeding to booking
```

## Why This Strategy?

**Alternative 1: Only the finder books**
- ❌ Single point of failure
- ❌ Wastes other 4 instances

**Alternative 2: Pass slot info to others**
- ❌ Complex coordination
- ❌ Race conditions
- ❌ Potential data corruption

**Current: All proceed to booking**
- ✅ Simple file-based broadcast
- ✅ All instances compete
- ✅ Best chance of success
- ✅ No complex coordination needed

The VFS booking system is first-come-first-served, so having 5 simultaneous attempts greatly increases your odds!

---

## Sentinel/Standby Mode (Advanced)

For large clusters (15-20 bots), enable **Sentinel Mode** to minimize server requests while maximizing booking speed.

### Concept

- **Sentinel Bots (3-4):** Actively poll for available slots at normal intervals.
- **Standby Bots (15-16):** Log in, maintain session, but stay idle (no polling requests).
- **Activation:** When any sentinel finds a slot, all standby bots immediately switch to aggressive burst polling.

### Configuration

Enable from the **setup UI**:
1. Check the **"Sentinel mode"** checkbox
2. Set the **"Sentinel count"** (how many bots actively poll — default 4)

No env vars needed.

### How It Works

```
Setup: 20 instances, SENTINEL_COUNT=4

Instances 1-4:  SENTINEL  → Active polling (normal intervals)
Instances 5-20: STANDBY   → Logged in, idle, session maintained

T+0s:   Sentinels 1-4 begin polling
T+0s:   Standby 5-20 enter idle loop (session keepalive every 5 min)
T+120s: Sentinel 2 finds a slot!
        → Writes slot-state.json (existing mechanism)
        → Writes sentinel-signal.json (activation broadcast)
T+120s: Standby 5-20 detect sentinel-signal.json via fs.watch
        → ALL wake up instantly
        → All go straight to booking chain (saveApplicants → calendar → timeslot → fees → schedule)

Result: 4 sentinels + 16 standby = 20 bots all racing to book!
```

### Benefits Over Default Mode

| | Default (all poll) | Sentinel Mode |
|---|---|---|
| Requests/minute | High (20 bots × normal interval) | Low (4 sentinels only) |
| Detection speed | Same | Same (sentinels cover it) |
| Booking speed | All already polling | All 20 go to booking instantly |
| Rate-limit risk | Higher | Lower (fewer active pollers) |
| Session expiry risk | Lower (constant activity) | Mitigated by keepalive pings |

### State Files

- `slot-state.json` — Standard slot-found broadcast (unchanged)
- `sentinel-signal.json` — Activation signal for standby bots (new)

Both are cleared on each fresh "Submit & Run" cycle.
