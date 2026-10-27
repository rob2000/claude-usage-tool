# Claude Usage Tool

A lightweight macOS menu bar application that displays your Claude Pro/Max subscription usage and API credit balance at a glance.

![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)
![Electron](https://img.shields.io/badge/electron-28.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

<p align="center">
  <img src="Claude%20Usage%20Tool%201.png" alt="Claude Usage Tool Screenshot">
</p>


## Why This Tool?

If you're a Claude power user, you've probably found yourself:
- Running `/status` in Claude Code repeatedly to check your limits
- Opening multiple browser tabs to check subscription usage and API credits
- Getting surprised by hitting rate limits mid-conversation

**Claude Usage Tool** solves this by putting your usage stats in your menu bar, always one click away.

## Features

- **Claude Max/Pro Usage Monitoring** - See your current usage across all models, Sonnet-only limits, and extra usage allocations
- **API Credit Balance** - View your remaining Claude API credits from platform.claude.com
- **Auto-Refresh** - Data updates every 60 seconds automatically
- **Activity Log** - Track when data was last fetched and monitor background operations
- **Menu Bar App** - Lives in your system tray, doesn't clutter your dock

## Demo

<p align="center">
  <img src="Claude%20Usage%20Tool%203.gif" alt="Claude Usage Tool Demo">
</p>

<p align="center">
  <img src="Claude%20Usage%20Tool%202.png" alt="Claude Usage Tool Screenshot">
</p>

### Linux

On Linux (here Cinnamon) the tray icon is the Claude burst with a gauge for the current session underneath, and the
usage page is read in German as well as English.

<p align="center">
  <img src="Claude%20Usage%20Tool%20Linux.png" alt="Claude Usage Tool on Linux">
</p>

## Installation

### Prerequisites

- macOS 12.0 or later
- Node.js 18+ and npm

### Quick Start

```bash
# Clone the repository
git clone https://github.com/kingigilbert/claude-usage-tool.git
cd claude-usage-tool

# Install dependencies
npm install

# Run in development mode
npm run electron:dev
```

### Building from Source

```bash
# Build the application
npm run build

# Create distributable .dmg
npm run electron:build
```

The built application will be in the `release/` directory.

## Usage

1. **Launch the app** - It appears as an icon in your menu bar
2. **Click the icon** - A popover displays your current usage stats
3. **Login when prompted** - The app will ask you to authenticate with Claude if needed
4. **View your stats** - Usage bars show percentage consumed and reset timers

### Authentication

The app requires you to log in to two separate services:

| Service | URL | Purpose |
|---------|-----|---------|
| Claude.ai | claude.ai | Subscription usage data (Pro/Max limits) |
| Platform | platform.claude.com | API credit balance |

Click the respective "Login" buttons in the app to authenticate. Your session is preserved between app restarts.

## Configuration

### Optional: Admin API Key

For advanced usage analytics, you can configure an Anthropic Admin API key:

1. Get your Admin Key from [Anthropic Console](https://console.anthropic.com/settings/admin-keys)
2. Create a `.env.local` file in the project root:

```bash
ANTHROPIC_ADMIN_KEY=sk-ant-admin-your-key-here
```

> **Note:** The `.env.local` file is gitignored to prevent accidentally committing credentials.

## Development

### Project Structure

```
claude-usage-tool/
├── electron/           # Main process (Electron)
│   ├── main.ts        # App lifecycle, window management
│   ├── scraper.ts     # Web scraping for usage data
│   ├── adminApi.ts    # Admin API client
│   └── preload.ts     # Secure IPC bridge
├── src/               # Renderer process (React)
│   ├── App.tsx        # Main application component
│   ├── components/    # UI components
│   └── types/         # TypeScript definitions
├── assets/            # App icons
└── package.json
```

### Available Scripts

| Script | Description |
|--------|-------------|
| `npm run electron:dev` | Start development mode with hot reload |
| `npm run build` | Build for production |
| `npm run electron:build` | Create distributable macOS app |
| `npm run lint` | Run ESLint |
| `npm start` | Run the built app |

### Tech Stack

- **Electron** - Cross-platform desktop framework
- **React** - UI components
- **TypeScript** - Type safety
- **Vite** - Build tooling
- **electron-builder** - App packaging

## How It Works

The app uses Electron's built-in browser windows to:

1. Load Claude's usage page (claude.ai/settings/usage) in a hidden window
2. Extract usage data from the page using JavaScript
3. Parse the data using regex patterns to identify usage percentages and reset times
4. Display the processed data in a native menu bar popover

This approach means:
- No API keys required for basic functionality
- Your Claude session cookies are securely stored by Electron
- Data is always fresh from the source

## Troubleshooting

### "Login Required" keeps appearing

Your session may have expired. Click the Login button to re-authenticate.

### Data not updating

1. Check the Activity Log at the bottom of the popover
2. Click the refresh button (↻) to manually trigger a refresh
3. Ensure you have an active internet connection

### App not appearing in menu bar

The app runs as a menu bar app only (no dock icon). Look for the Claude icon in your system tray.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Electron](https://www.electronjs.org/)
- Inspired by the need to stop running `/status` every five minutes

---

**Note:** This is an unofficial tool and is not affiliated with or endorsed by Anthropic. Claude, Claude Pro, and Claude Max are trademarks of Anthropic.
