# Instance Data Persistence

## Overview

All instance credentials and applicant details are now **automatically saved to disk** and will persist across bot restarts.

## Storage File

**Location:** `instances-data.json` (in the bot root directory)

**Format:**
```json
{
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
        "emailId": "john@example.com",
        ...
      }
    },
    "2": {
      "credentials": { ... },
      "details": { ... }
    },
    ...
  }
}
```

## How It Works

### Auto-Save to Disk
- Every time you save data (auto-save or manual), it's written to `instances-data.json`
- No manual action needed
- Instant persistence

### Auto-Load on Startup
- When you start the bot, it automatically loads `instances-data.json`
- All your saved instances are immediately available
- Form UI shows saved data when you select each instance

## Workflow

### First Time Setup
1. Start bot: `npm run dev:cluster`
2. Open form: `http://127.0.0.1:3847`
3. Fill Instance 1 → Auto-saved to disk
4. Fill Instance 2 → Auto-saved to disk
5. Fill Instance 3 → Auto-saved to disk
6. Fill Instance 4 → Auto-saved to disk
7. Fill Instance 5 → Auto-saved to disk
8. Click "Submit & Run All Instances"

### After Restart
1. Restart bot: `npm run dev:cluster`
2. Open form: `http://127.0.0.1:3847`
3. **All data is already there!**
   - Select Instance 1 → Shows saved data
   - Select Instance 2 → Shows saved data
   - etc.
4. Click "Submit & Run All Instances" (or edit data first)

## Benefits

✓ **No re-entering data** - Set up once, use forever
✓ **Survive crashes** - Data is saved immediately, not just on shutdown
✓ **Easy backup** - Copy `instances-data.json` to backup your config
✓ **Easy sharing** - Share the file with team members
✓ **Version control** - Track changes to your instances

## Security Notes

### Credentials in Plain Text
⚠️ **The file contains passwords in plain text!**

- Keep `instances-data.json` secure
- Don't commit it to git (already in `.gitignore`)
- Don't share it publicly
- Store it in a secure location

### Recommended Security
If you need to share or version control:
1. Use environment variables for passwords instead
2. Or encrypt the file manually
3. Or use a secrets manager

## Managing the File

### View Current Data
```bash
cat instances-data.json
# or
type instances-data.json  # Windows
```

### Backup
```bash
cp instances-data.json instances-data.backup.json
```

### Reset All Instances
```bash
rm instances-data.json
# or
del instances-data.json  # Windows
```
Then restart the bot - starts fresh with no saved data.

### Edit Manually
You can edit `instances-data.json` directly if needed:
1. Stop the bot
2. Edit the file
3. Restart the bot

Format must be valid JSON or it will be ignored.

## Troubleshooting

### Data Not Loading
- Check if `instances-data.json` exists
- Check if it's valid JSON (use a JSON validator)
- Check bot logs for "Loaded instance data from disk"

### Data Not Saving
- Check file permissions (bot needs write access)
- Check disk space
- Check bot logs for save errors

### Want Fresh Start
1. Delete or rename `instances-data.json`
2. Restart bot
3. All instances will be empty
