# Connecting Apple Mail and Calendar to Rowboat (macOS only)

Rowboat can sync your Apple Mail and Calendar data locally without using any cloud APIs. This integration reads directly from the local SQLite databases on your Mac.

---

## Requirements

- **macOS only**: These integrations are only available on macOS systems
- **macOS Sequoia (15.0+)**: May require "Full Disk Access" permission
- **Apple Mail.app**: Must be installed and configured with at least one email account
- **Calendar.app**: Must be installed and configured

---

## Privacy & Security

- **Local-only**: All data is read from local SQLite databases on your Mac
- **No iCloud API**: Does not connect to Apple's cloud services
- **Read-only access**: Opens databases in read-only mode to prevent any corruption
- **No data transmission**: Your email and calendar data stays on your machine

---

## Enabling Apple Mail Sync

Apple Mail sync reads emails from your local Mail.app database and syncs them to Rowboat's knowledge graph.

### 1️⃣ Open Rowboat Onboarding

When you first launch Rowboat on macOS, you'll see the onboarding modal with integration options.

### 2️⃣ Navigate to Account Connections

Go to the "Connect Your Accounts" step in the onboarding flow.

### 3️⃣ Enable Apple Mail

Under "Local Sources (macOS)", toggle the **Apple Mail** switch to enable syncing.

![Apple Mail toggle](https://raw.githubusercontent.com/rowboatlabs/rowboat/main/apps/docs/docs/img/apple-setup/apple-mail-toggle.png)

### 4️⃣ Grant Full Disk Access (macOS Sequoia+)

If you're on macOS Sequoia (15.0) or later, you may need to grant Rowboat "Full Disk Access" permission:

1. Open **System Settings** → **Privacy & Security** → **Full Disk Access**
2. Click the **+** button
3. Navigate to and select the Rowboat application
4. Restart Rowboat for the changes to take effect

### What Gets Synced

- **Time range**: Last 30 days of messages
- **Format**: Emails are converted to markdown files
- **Location**: `~/.rowboat/apple_mail_sync/`
- **Sync frequency**: Every 5 minutes

---

## Enabling Apple Calendar Sync

Apple Calendar sync reads events from your local Calendar.app database and syncs them to Rowboat's knowledge graph.

### 1️⃣ Open Rowboat Onboarding

When you first launch Rowboat on macOS, you'll see the onboarding modal with integration options.

### 2️⃣ Navigate to Account Connections

Go to the "Connect Your Accounts" step in the onboarding flow.

### 3️⃣ Enable Apple Calendar

Under "Local Sources (macOS)", toggle the **Apple Calendar** switch to enable syncing.

![Apple Calendar toggle](https://raw.githubusercontent.com/rowboatlabs/rowboat/main/apps/docs/docs/img/apple-setup/apple-calendar-toggle.png)

### 4️⃣ Grant Full Disk Access (macOS Sequoia+)

If you're on macOS Sequoia (15.0) or later, you may need to grant Rowboat "Full Disk Access" permission:

1. Open **System Settings** → **Privacy & Security** → **Full Disk Access**
2. Click the **+** button
3. Navigate to and select the Rowboat application
4. Restart Rowboat for the changes to take effect

### What Gets Synced

- **Time range**: 14 days in the past to 14 days in the future
- **Format**: Events are stored as JSON files
- **Location**: `~/.rowboat/apple_calendar_sync/`
- **Sync frequency**: Every 5 minutes
- **Cleanup**: Old events outside the sync window are automatically removed

---

## Technical Details

### Database Locations

- **Mail**: `~/Library/Mail/V{version}/MailData/Envelope Index`
- **Calendar**: `~/Library/Calendars/Calendar.sqlitedb`

### How It Works

1. Rowboat scans for the latest Mail database version folder (e.g., V10, V11)
2. Opens the SQLite database in read-only mode
3. Queries for recent messages/events based on the sync window
4. Converts data to markdown (Mail) or JSON (Calendar) format
5. Writes files to the Rowboat knowledge directory
6. The knowledge graph builder processes these files into your knowledge graph

### Database Locking

If Mail.app or Calendar.app has the database locked, Rowboat will:
- Retry up to 3 times with exponential backoff
- Log the issue without crashing
- Try again on the next sync cycle (5 minutes later)

### Troubleshooting

**"Mail database not found"**
- Ensure Mail.app is installed and configured with at least one email account
- Check that the Mail database exists at `~/Library/Mail/`

**"Calendar database not found"**
- Ensure Calendar.app is installed
- Check that the Calendar database exists at `~/Library/Calendars/Calendar.sqlitedb`

**"Could not open database (may be locked)"**
- Mail.app or Calendar.app currently has the database open
- Rowboat will automatically retry on the next sync cycle
- Consider closing the app temporarily if syncing is urgent

**"Permission denied" errors**
- Grant "Full Disk Access" permission in System Settings (see steps above)
- Restart Rowboat after granting permission

---

## Disabling Syncing

To disable Apple Mail or Calendar syncing:

1. Open Rowboat settings or re-run the onboarding
2. Navigate to the integrations section
3. Toggle off the Apple Mail or Apple Calendar switch
4. Syncing will stop immediately

Existing synced files in `~/.rowboat/` will remain but won't be updated.

---

## Comparison with Google Integrations

| Feature | Apple Mail/Calendar | Gmail/Google Calendar |
|---------|-------------------|---------------------|
| **Platform** | macOS only | All platforms |
| **Data source** | Local SQLite databases | Google Cloud API |
| **Privacy** | 100% local, no cloud access | Requires OAuth, data via Google |
| **Setup** | Toggle in Rowboat + system permission | OAuth flow + Google Cloud project |
| **Offline access** | ✅ Works offline | ❌ Requires internet |
| **Attachments** | ❌ Not yet supported | ✅ Supported |

---
