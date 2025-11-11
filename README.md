# Email Dashboard - Desktop App

A native macOS desktop application for intelligent email management powered by AI. Built with Tauri, React, and OpenAI's GPT-4o-mini.

## Features

### 🤖 AI-Powered Email Analysis
- **Auto-summarization**: Every email is automatically analyzed by GPT-4o-mini
- **Smart categorization**: Emails tagged as Urgent, Action Needed, Waiting on Others, or FYI
- **Priority scoring**: 1-10 priority scale for quick triage
- **Action item extraction**: Automatically identifies tasks and deadlines
- **Key points highlighting**: Extracts important information from long emails

### 📧 Gmail Integration
- **Native OAuth flow**: Secure system browser authentication (no embedded webviews)
- **PKCE implementation**: Enhanced security for desktop OAuth
- **Persistent sessions**: Auto-reconnect with refresh tokens
- **Auto-sync**: Fetches emails every 5 minutes automatically
- **Full Gmail API**: Compose, send, archive, and trash emails

### ✍️ AI Reply Drafting
- **One-click drafts**: Generate context-aware email replies
- **Editable drafts**: Refine AI-generated content before sending
- **Gmail integration**: Drafts saved directly to Gmail
- **Threading support**: Maintains email conversation context

### 📊 Productivity Dashboard
- **Action backlog**: Aggregated view of all action items across emails
- **Deadline radar**: Track all upcoming deadlines in one place
- **Category metrics**: Visual breakdown of email types
- **Smart digests**: Generate morning briefings or evening recaps

## Tech Stack

- **Frontend**: React + TypeScript + Vite
- **Desktop Framework**: Tauri 2.x (Rust)
- **Styling**: Tailwind CSS
- **AI**: OpenAI GPT-4o-mini
- **APIs**: Gmail API v1

## Prerequisites

- **macOS**: This app is currently built for macOS (Apple Silicon)
- **Node.js**: v18 or higher
- **Rust**: Latest stable (installed via rustup)
- **OpenAI API Key**: Required for AI features
- **Google OAuth Credentials**: Required for Gmail access

## Setup Instructions

### 1. Clone the Repository

```bash
git clone <your-repo-url>
cd email-dashboard
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Install Rust (if not already installed)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
```

### 4. Configure API Keys

**⚠️ IMPORTANT: Never commit your `src/config.ts` file to git!**

Create or update `src/config.ts` with your credentials:

```typescript
// src/config.ts
export const OPENAI_API_KEY = 'sk-proj-YOUR_OPENAI_API_KEY';
export const GOOGLE_OAUTH_CLIENT_ID = 'YOUR_WEB_CLIENT_ID.apps.googleusercontent.com';
export const GOOGLE_OAUTH_DESKTOP_CLIENT_ID = 'YOUR_DESKTOP_CLIENT_ID.apps.googleusercontent.com';
export const GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET = 'GOCSPX-YOUR_CLIENT_SECRET';
```

### 5. Set Up Google OAuth

#### Create OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable **Gmail API**
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**

#### Desktop Application OAuth Client

1. Application type: **Desktop app**
2. Name: `Email Dashboard Desktop`
3. Copy the **Client ID** → use as `GOOGLE_OAUTH_DESKTOP_CLIENT_ID`
4. Copy the **Client secret** → use as `GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET`

#### Configure OAuth Consent Screen

1. Go to **OAuth consent screen**
2. Add the following scopes:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/userinfo.email`

#### Add Authorized Redirect URI

1. In your **Desktop app** OAuth client settings
2. Add authorized redirect URI: `http://localhost:3737`

### 6. Get OpenAI API Key

1. Go to [OpenAI Platform](https://platform.openai.com/)
2. Navigate to **API Keys**
3. Create new secret key
4. Copy and add to `src/config.ts`

## Development

### Run in Development Mode

```bash
npm run tauri:dev
```

This will:
- Start Vite dev server on port 5173
- Launch Tauri desktop window
- Enable hot-reload for frontend changes

### Build Production DMG

```bash
npm run tauri:build
```

Output location:
```
src-tauri/target/release/bundle/dmg/Email Dashboard_0.1.0_aarch64.dmg
```

## Usage

### First Launch

1. Launch the app
2. Click "Connect Gmail"
3. System browser opens for OAuth
4. Grant permissions
5. Return to app - emails auto-fetch

### Automatic Features

The app automatically:
- Reconnects on launch using saved refresh token
- Fetches emails on startup
- Refreshes inbox every 5 minutes
- Analyzes new emails with AI as they arrive

### Manual Actions

- **View email**: Click any email in the list
- **Generate reply**: Click "Auto Reply Draft"
- **Edit draft**: Modify AI-generated text in textarea
- **Send reply**: Click "Send Reply"
- **Archive**: Remove from inbox
- **Delete**: Move to trash
- **Generate digest**: Click "Generate morning/evening digest"

## Project Structure

```
email-dashboard/
├── src/
│   ├── email-productivity-dashboard.tsx  # Main React component
│   ├── config.ts                          # API keys (DO NOT COMMIT!)
│   ├── main.tsx                           # React entry point
│   └── index.css                          # Tailwind styles
├── src-tauri/
│   ├── src/
│   │   └── lib.rs                         # OAuth server + Tauri commands
│   ├── Cargo.toml                         # Rust dependencies
│   └── tauri.conf.json                    # Tauri configuration
├── package.json
└── README.md
```

## Security Considerations

### 🔒 Do NOT Commit:
- `src/config.ts` - Contains API keys and OAuth credentials
- `.env` files
- `node_modules/`
- `dist/` and `src-tauri/target/` build outputs
- `.dmg` or `.app` files

### ✅ Best Practices:
- Keep `config.ts` in `.gitignore`
- Rotate API keys regularly
- Use OAuth refresh tokens (already implemented)
- Review Google Cloud OAuth consent screen regularly

## OAuth Flow Details

This app uses **PKCE (Proof Key for Code Exchange)** for secure desktop OAuth:

1. App generates code_verifier and code_challenge
2. Opens system browser with Google OAuth URL
3. Starts local HTTP server on port 3737
4. User authorizes in browser
5. Google redirects to `http://localhost:3737?code=...`
6. App exchanges authorization code + code_verifier for tokens
7. Saves access_token and refresh_token to localStorage

## Troubleshooting

### Port 3737 already in use
```bash
# Kill any process using port 3737
lsof -ti:3737 | xargs kill -9
```

### OAuth redirect_uri_mismatch
- Ensure `http://localhost:3737` is in Google OAuth authorized redirect URIs
- Check bundle identifier in `src-tauri/tauri.conf.json`

### Token expired errors
- App should auto-refresh tokens
- If it fails, click "Connect Gmail" to re-authenticate

### Build fails with Cargo not found
```bash
source "$HOME/.cargo/env"
npm run tauri:build
```

## Known Limitations

- macOS only (Apple Silicon)
- Fetches last 15 emails from inbox (hardcoded)
- AI analysis requires OpenAI API (costs money)
- No offline mode

## Future Enhancements

- [ ] Support for multiple email accounts
- [ ] Custom refresh intervals
- [ ] Email search and filters
- [ ] Desktop notifications
- [ ] Keyboard shortcuts
- [ ] Dark mode toggle
- [ ] Windows/Linux builds

## License

MIT
