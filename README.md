# CallSteer Widget

A desktop widget for real-time AI coaching nudges for sales reps.

## Features

- **Always on top** - Stays visible above all windows
- **Frameless & draggable** - Clean UI with custom window controls
- **System tray integration** - Minimize to system tray
- **Real-time nudges** - Polls API every 2 seconds for new coaching nudges
- **Notification sounds** - Alert when new nudge arrives
- **Three tabs**:
  - **Nudges** - View real-time coaching suggestions
  - **My Stats** - Track your adoption rate, streak, and nudge counts
  - **Leaderboard** - See how you rank against other sales reps

## Installation

1. Install dependencies:
```bash
npm install
```

## Running the App

### Development Mode
```bash
npm start
```

### Build Executable
```bash
npm run build
```

The built executable will be in the `dist` folder.

## API Endpoints

- **Nudges/Objections**: `https://callsteer-backend-production.up.railway.app/api/analytics/objections`
- **Leaderboard**: `https://callsteer-backend-production.up.railway.app/api/gamification/leaderboard`

## Controls

- **Drag** - Click and drag the header to move the window
- **Minimize** - Click the minus button to hide to system tray
- **Close** - Click the X button to hide the widget (doesn't quit)
- **System Tray** - Right-click the tray icon to show/hide/quit

## Customization

### Change Window Size
Edit [main.js](main.js:9-10):
```javascript
width: 400,
height: 500,
```

### Change Poll Interval
Edit [renderer.js](renderer.js:2):
```javascript
const POLL_INTERVAL = 2000; // milliseconds
```

### Styling
All styles are in [styles.css](styles.css). The app uses:
- Background: `#1a1a2e`
- Accent: `#00C8D4` (blue-cyan)
- Streak: `#ffd700` (gold)

## Notes

- The icon.png file is a placeholder. Replace it with your own icon for better tray appearance.
- Notification sound uses a built-in beep. You can replace it with a custom sound file if needed.
- The app requires an active internet connection to fetch data from the API.
