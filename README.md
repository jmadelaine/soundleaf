# SoundLeaf

SoundLeaf is a local-first browser app for reading EPUBs with an optional companion audio track.

Try it at [soundleaf.netlify.app](https://soundleaf.netlify.app/).

The main panel opens an EPUB in a dark, paginated reader. The bottom panel opens an audio file with playback, seeking, speed, volume, and resume controls. Files stay in the browser: SoundLeaf stores one EPUB and one audio file in IndexedDB so the last loaded files can reopen after a reload.

## Features

- Drag-and-drop or button-based EPUB loading
- Dark, paginated EPUB reader with one page shown at a time
- Left/right keyboard navigation and clickable side page zones
- Forced left-to-right horizontal layout for vertical-text EPUBs
- EPUB text zoom with persisted settings
- Whole-book progress percentage when EPUB locations are available
- Number-key EPUB jumps from `0%` through `90%`
- Drag-and-drop or button-based audio loading
- Audio play/pause, 5-second skip controls, scrubber, playback speed, volume, and mute
- Per-file resume progress using SHA-256 hashes
- One cached EPUB and one cached audio file in IndexedDB
- Clear-cache recovery buttons if cached file restore fails
- Persistent reader and audio settings in localStorage
- Netlify SPA fallback routing via `netlify.toml`

## Keyboard Shortcuts

- `Right Arrow`: next EPUB page
- `Left Arrow`: previous EPUB page
- `0` through `9`: jump to EPUB progress position (`0` = start, `1` = 10%, ..., `9` = 90%)
- `+`: increase EPUB text size
- `-`: decrease EPUB text size
- `Space`: play/pause audio
- `Shift + Right Arrow`: skip audio forward 5 seconds
- `Shift + Left Arrow`: skip audio back 5 seconds

## Local Storage

SoundLeaf does not upload EPUB or audio files. File data is stored locally in IndexedDB, with a maximum of one cached EPUB and one cached audio file. Dropping or opening a new file replaces the previous cached file of that type.

Reader/audio settings and resume positions are stored in localStorage. Resume positions are keyed by SHA-256 content hashes, so reopening the same file can restore the last book location or audio timestamp.

## Development

Install dependencies:

```sh
npm install
```

Run the development server:

```sh
npm run dev
```

Build for production:

```sh
npm run build
```

Preview the production build:

```sh
npm run preview
```

Format files:

```sh
npm run format
```

Run Oxlint:

```sh
npm run lint
```

## Deployment

The app is ready for Netlify. `netlify.toml` sets the build command to `npm run build`, publishes `dist`, uses Node 26, and redirects all routes to `index.html` for SPA fallback behavior.
