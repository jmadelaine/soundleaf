# SoundLeaf

SoundLeaf is a browser-based EPUB reader with an audio companion track.

Drop an EPUB into the main reader area to open it in a dark, paginated reading view. Drop an audio file into the bottom player to listen alongside the book.

## Features

- Local drag-and-drop EPUB loading
- Dark mode EPUB rendering
- Paginated reading with left/right arrow navigation
- Optional forced horizontal layout for vertical text EPUBs
- EPUB text zoom with keyboard shortcuts
- Local drag-and-drop audio loading
- Audio play/pause, seek, scrubber, and playback speed controls
- Per-file resume progress using SHA-256 hashes in localStorage
- Persistent reader and audio settings

## Keyboard Shortcuts

- `Right Arrow`: next EPUB page
- `Left Arrow`: previous EPUB page
- `+`: increase EPUB text size
- `-`: decrease EPUB text size
- `Space`: play/pause audio
- `Shift + Right Arrow`: skip audio forward 10 seconds
- `Shift + Left Arrow`: skip audio back 10 seconds

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

## Notes

SoundLeaf processes dropped EPUB and audio files locally in the browser. Files are not uploaded by the app. Resume state is stored in localStorage using content hashes as file keys.
