# Per-Instance Credentials & Details

## Overview

Each bot instance can now have its own:
- **Login credentials** (VFS username/password)
- **Applicant details** (name, passport, etc.)

This allows 5 different "users" to run simultaneously, each with their own account and applicant data.

## How It Works

### Form UI - Per Instance Data

When you open `http://127.0.0.1:3847` in cluster mode, you'll see:

```
┌─────────────────────────────────────────┐
│ Bot Instance                            │
│ Select instance (each uses different IP)│
│ ┌─────────────────────────────────────┐ │
│ │ Instance 1                        ▼ │ │
│ └─────────────────────────────────────┘ │
│ [Load Saved Data for This Instance]    │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ VFS Login                               │
│ Email/username: ___________________     │
│ Password: _________________________     │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Applicant Details                       │
│ First name: _______  Last name: _______ │
│ Email: ______________________________   │
│ ... (more fields)                       │
└─────────────────────────────────────────┘

[Submit]
```

### Workflow

1. **Select Instance** - Choose which instance (1-5)
2. **Optional: Load Saved Data** - Click "Load Saved Data" button to auto-fill previously saved credentials/details for that instance
3. **Fill/Edit Form** - Enter or modify the credentials and applicant details
4. **Submit** - Saves data for that specific instance and starts the bot cycle

### Data Storage

Data is stored **per instance** in memory:
- Instance 1 → Username A, Applicant A
- Instance 2 → Username B, Applicant B
- Instance 3 → Username C, Applicant C
- etc.

Each time you submit for an instance, it **overwrites** the previous data for that instance.

### Example Usage

**Setting up 5 different accounts:**

1. Select "Instance 1"
   - Enter: user1@example.com / password1
   - Enter: John Doe, passport ABC123
   - Click Submit

2. Select "Instance 2"
   - Enter: user2@example.com / password2
   - Enter: Jane Smith, passport XYZ789
   - Click Submit

3. Select "Instance 3"
   - Enter: user3@example.com / password3
   - Enter: Bob Wilson, passport DEF456
   - Click Submit

... and so on.

**Later, updating Instance 2:**

1. Select "Instance 2"
2. Click "Load Saved Data for This Instance"
   - Form auto-fills with: user2@example.com and Jane Smith's details
3. Modify any fields you want
4. Click Submit to update

## API Endpoint

The form server exposes:

**GET /api/instances**

Returns all saved instance data:

```json
{
  "ok": true,
  "instances": {
    "1": {
      "credentials": {
        "username": "user1@example.com",
        "password": "password1"
      },
      "details": {
        "firstName": "John",
        "lastName": "Doe",
        "passportNumber": "ABC123",
        ...
      }
    },
    "2": {
      "credentials": { ... },
      "details": { ... }
    }
  }
}
```

## Important Notes

### Data Persistence

**In-Memory Only**: All instance data is stored in memory and will be lost when you restart the cluster. This is by design for security (no credentials on disk).

To preserve data across restarts:
- Take note of your credentials/details
- Or export via the API endpoint before shutdown

### Instance Matching

The bot automatically matches the submitted data to the correct instance:
- Each Chrome instance reads `BOT_INSTANCE_ID` from its environment
- When login/polling happens, it retrieves the credentials for that specific instance ID
- This ensures Instance 1 always uses the data you submitted for Instance 1

### Single Instance Mode

If `VFS_BOT_INSTANCES=1` or you use `npm run dev` (not cluster), the form works as before with no instance selector.

## Benefits

✓ **Multiple Accounts**: Run 5 different VFS accounts simultaneously
✓ **Different Identities**: Each instance can book for different people
✓ **IP Diversity**: Combined with proxy, looks like 5 real users
✓ **Easy Management**: Visual form to set up and modify each instance
✓ **Data Isolation**: No risk of mixing up credentials between instances
