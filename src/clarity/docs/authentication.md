# Clarity PPM Authentication

## Overview

Clarity PPM uses cookie-based authentication via SSO. Two credentials are needed:

1. **`authToken`** - Sent as an HTTP header
2. **`sessionId`** - Originally a cookie, but can also be sent as header

Both have the same format: `{sessionNumber}__{UUID}` (e.g., `12345678__A1B2C3D4-E5F6-7890-ABCD-EF1234567890`).

## Extracting Credentials from Browser

### Step 1: Open DevTools

1. Log into Clarity PPM in your browser
2. Navigate to Timesheets
3. Open Developer Tools (F12 or Cmd+Shift+I)
4. Go to the **Network** tab

### Step 2: Copy as cURL

1. Find any request to `/ppm/rest/v1/` in the Network tab
2. Right-click the request
3. Select **Copy** > **Copy as cURL**

### Step 3: Configure Tool

```bash
tools clarity configure
```

Paste the copied cURL command when prompted. The tool automatically extracts:
- `authToken` from the request headers
- `sessionId` from cookies
- `baseUrl` from the request URL

## Session Lifecycle

| Event | Duration | Notes |
|-------|----------|-------|
| Initial login | Valid for browser session | Tied to SSO session |
| Idle timeout | ~30 minutes typical | Varies by deployment |
| SSO refresh | Automatic in browser | Extends session silently |
| Token expiry | When SSO session ends | Requires re-login |

## Re-authentication

When the session expires, the API returns `401 Unauthorized`. To refresh:

1. Log into the Clarity web UI (this refreshes the SSO session)
2. Copy a fresh cURL from DevTools
3. Run `tools clarity configure` again

## Security Notes

- Credentials are stored locally at `~/.genesis-tools/clarity/config.json`
- The config file should have restricted permissions (user-only read/write)
- Never commit credentials to version control
- The `tools clarity configure show` command redacts sensitive values in output
