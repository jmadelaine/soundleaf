import { useCallback, useEffect, useRef, useState } from "react";
import ePub, { type Book, type Contents, type Rendition } from "epubjs";
import {
  ChevronLeft,
  ChevronRight,
  FileAudio,
  FileText,
  Loader2,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react";

type LoadState = "empty" | "loading" | "ready" | "error";
type TextLayout = "book" | "horizontal";
type ReadingDirection = "ltr" | "rtl";

type SoundLeafSettings = {
  reader: {
    forceHorizontal: boolean;
    textSize: number;
  };
  audio: {
    playbackRate: number;
  };
};

type SoundLeafProgress = {
  books: Record<string, { cfi: string; name: string; updatedAt: number }>;
  audio: Record<string, { currentTime: number; name: string; updatedAt: number }>;
};

type ReaderProgress = {
  percentage: number | null;
};

type EpubRelocatedLocation = {
  start?: {
    cfi?: string;
    displayed?: {
      page?: number;
      total?: number;
    };
    percentage?: number;
  };
};

type RenditionWithResizeTarget = Rendition & {
  resize(width: number, height: number, epubcfi?: string): void;
};

const THEME_BY_TEXT_LAYOUT: Record<TextLayout, string> = {
  book: "soundleaf-dark",
  horizontal: "soundleaf-dark-horizontal",
};

const SETTINGS_STORAGE_KEY = "soundleaf.settings.v1";
const PROGRESS_STORAGE_KEY = "soundleaf.progress.v1";
const TEXT_SIZE_OPTIONS = [80, 90, 100, 110, 125, 140, 175, 200, 225, 250, 275, 300, 350, 400] as const;
const DEFAULT_TEXT_SIZE = 100;
const MIN_TEXT_SIZE = TEXT_SIZE_OPTIONS[0];
const MAX_TEXT_SIZE = TEXT_SIZE_OPTIONS[TEXT_SIZE_OPTIONS.length - 1];
const DEFAULT_PLAYBACK_RATE = 1;
const PLAYBACK_RATE_OPTIONS = [
  0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4,
  1.45, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.2, 2.4, 2.6, 2.8, 3, 3.2, 3.4, 3.6, 3.8, 4,
] as const;
const MIN_PLAYBACK_RATE = PLAYBACK_RATE_OPTIONS[0];
const MAX_PLAYBACK_RATE = PLAYBACK_RATE_OPTIONS[PLAYBACK_RATE_OPTIONS.length - 1];
const DEFAULT_SETTINGS: SoundLeafSettings = {
  reader: {
    forceHorizontal: false,
    textSize: DEFAULT_TEXT_SIZE,
  },
  audio: {
    playbackRate: DEFAULT_PLAYBACK_RATE,
  },
};
const DEFAULT_PROGRESS: SoundLeafProgress = {
  books: {},
  audio: {},
};

const EPUB_FONT_STYLESHEET_URL = "https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@400&display=swap";
const DARK_READER_THEME = {
  body: {
    background: "#101214 !important",
    color: "#f2f5f7 !important",
    "font-family": "\"M PLUS Rounded 1c\", system-ui, sans-serif !important",
    "font-weight": "400 !important",
    "line-height": "1.5 !important",
  },
  "html, body": {
    background: "#101214 !important",
  },
  "a, a:visited": {
    color: "#8cc8ff !important",
  },
  "::selection": {
    background: "#2f6f84 !important",
  },
};
const HORIZONTAL_READER_THEME = {
  ...DARK_READER_THEME,
  "html, body": {
    ...DARK_READER_THEME["html, body"],
    direction: "ltr !important",
    "text-align": "left !important",
    "writing-mode": "horizontal-tb !important",
    "-webkit-writing-mode": "horizontal-tb !important",
  },
  body: {
    ...DARK_READER_THEME.body,
    direction: "ltr !important",
    "text-align": "left !important",
    "writing-mode": "horizontal-tb !important",
    "-webkit-writing-mode": "horizontal-tb !important",
  },
  "body, body *": {
    direction: "ltr !important",
    "text-align": "left !important",
    "text-orientation": "mixed !important",
    "writing-mode": "horizontal-tb !important",
    "-webkit-writing-mode": "horizontal-tb !important",
  },
};

type BookWithDirectionMetadata = Book & {
  package?: {
    metadata?: {
      direction?: string | null;
    };
  };
};

function isFileDrag(event: React.DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function isAudioFile(file: File) {
  return file.type.startsWith("audio/") || /\.(aac|aif|aiff|flac|m4a|mp3|ogg|wav|webm)$/i.test(file.name);
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "input" || tagName === "select" || tagName === "textarea";
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return "0:00";
  }

  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60)
    .toString()
    .padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function getStoredProgress(): SoundLeafProgress {
  try {
    const storedProgress = window.localStorage.getItem(PROGRESS_STORAGE_KEY);
    if (!storedProgress) {
      return DEFAULT_PROGRESS;
    }

    const parsedProgress = JSON.parse(storedProgress) as Partial<SoundLeafProgress>;
    return {
      books: parsedProgress.books ?? {},
      audio: parsedProgress.audio ?? {},
    };
  } catch {
    return DEFAULT_PROGRESS;
  }
}

function updateStoredProgress(updater: (progress: SoundLeafProgress) => SoundLeafProgress) {
  const nextProgress = updater(getStoredProgress());
  window.localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(nextProgress));
}

async function hashArrayBuffer(buffer: ArrayBuffer) {
  const digest = await window.crypto.subtle.digest("SHA-256", buffer);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function nearestOption(value: number, options: readonly number[]) {
  return options.reduce((nearestValue, option) =>
    Math.abs(option - value) < Math.abs(nearestValue - value) ? option : nearestValue,
  );
}

function nextLargerTextSize(size: number) {
  return TEXT_SIZE_OPTIONS.find((option) => option > size) ?? MAX_TEXT_SIZE;
}

function nextSmallerTextSize(size: number) {
  return [...TEXT_SIZE_OPTIONS].reverse().find((option) => option < size) ?? MIN_TEXT_SIZE;
}

function normalizeTextSize(size: number) {
  return nearestOption(size, TEXT_SIZE_OPTIONS);
}

function normalizePlaybackRate(rate: number) {
  return nearestOption(rate, PLAYBACK_RATE_OPTIONS);
}

function nextLargerPlaybackRate(rate: number) {
  return PLAYBACK_RATE_OPTIONS.find((option) => option > rate) ?? MAX_PLAYBACK_RATE;
}

function nextSmallerPlaybackRate(rate: number) {
  return [...PLAYBACK_RATE_OPTIONS].reverse().find((option) => option < rate) ?? MIN_PLAYBACK_RATE;
}

function getInitialSettings(): SoundLeafSettings {
  try {
    const storedSettings = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!storedSettings) {
      return DEFAULT_SETTINGS;
    }

    const parsedSettings = JSON.parse(storedSettings) as Partial<SoundLeafSettings>;
    return {
      reader: {
        forceHorizontal: parsedSettings.reader?.forceHorizontal === true,
        textSize: normalizeTextSize(
          typeof parsedSettings.reader?.textSize === "number" ? parsedSettings.reader.textSize : DEFAULT_TEXT_SIZE,
        ),
      },
      audio: {
        playbackRate: normalizePlaybackRate(
          typeof parsedSettings.audio?.playbackRate === "number"
            ? parsedSettings.audio.playbackRate
            : DEFAULT_PLAYBACK_RATE,
        ),
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function App() {
  const readerRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const bookDirectionRef = useRef<ReadingDirection>("ltr");
  const bookHashRef = useRef<string | null>(null);
  const audioHashRef = useRef<string | null>(null);
  const latestBookCfiRef = useRef<string | null>(null);

  const [bookName, setBookName] = useState("");
  const [audioName, setAudioName] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("empty");
  const [isBookDragActive, setIsBookDragActive] = useState(false);
  const [isAudioDragActive, setIsAudioDragActive] = useState(false);
  const [isAudioReady, setIsAudioReady] = useState(false);
  const [isAudioPaused, setIsAudioPaused] = useState(true);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [settings, setSettings] = useState<SoundLeafSettings>(getInitialSettings);
  const [readerProgress, setReaderProgress] = useState<ReaderProgress>({
    percentage: null,
  });
  const [error, setError] = useState("");
  const [audioError, setAudioError] = useState("");

  const textLayout: TextLayout = settings.reader.forceHorizontal ? "horizontal" : "book";
  const textSize = settings.reader.textSize;
  const playbackRate = settings.audio.playbackRate;

  const destroyBook = useCallback(() => {
    renditionRef.current?.destroy();
    renditionRef.current = null;

    bookRef.current?.destroy();
    bookRef.current = null;
    bookDirectionRef.current = "ltr";
    bookHashRef.current = null;
    latestBookCfiRef.current = null;
    setReaderProgress({
      percentage: null,
    });

    if (readerRef.current) {
      readerRef.current.replaceChildren();
    }
  }, []);

  const destroyAudio = useCallback(() => {
    const audio = audioRef.current;

    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }

    audioHashRef.current = null;
    setIsAudioReady(false);
    setIsAudioPaused(true);
    setAudioCurrentTime(0);
    setAudioDuration(0);
  }, []);

  const navigate = useCallback((direction: "prev" | "next") => {
    const rendition = renditionRef.current;
    if (!rendition) {
      return;
    }

    const shouldInvert = textLayout === "book" && bookDirectionRef.current === "rtl";
    const action = shouldInvert ? (direction === "next" ? "prev" : "next") : direction;

    if (action === "next") {
      void rendition.next();
    } else {
      void rendition.prev();
    }
  }, [textLayout]);

  const saveAudioProgress = useCallback((currentTime: number) => {
    const currentHash = audioHashRef.current;
    if (!currentHash || !audioName || !Number.isFinite(currentTime)) {
      return;
    }

    updateStoredProgress((progress) => ({
      ...progress,
      audio: {
        ...progress.audio,
        [currentHash]: {
          currentTime,
          name: audioName,
          updatedAt: Date.now(),
        },
      },
    }));
  }, [audioName]);

  const saveBookProgress = useCallback(() => {
    const currentHash = bookHashRef.current;
    const cfi = latestBookCfiRef.current;
    if (!currentHash || !bookName || !cfi) {
      return;
    }

    updateStoredProgress((progress) => ({
      ...progress,
      books: {
        ...progress.books,
        [currentHash]: {
          cfi,
          name: bookName,
          updatedAt: Date.now(),
        },
      },
    }));
  }, [bookName]);

  const updateTextSize = useCallback((nextSize: number) => {
    setSettings((currentSettings) => ({
      ...currentSettings,
      reader: {
        ...currentSettings.reader,
        textSize: normalizeTextSize(nextSize),
      },
    }));
  }, []);

  const seekAudio = useCallback((deltaSeconds: number) => {
    const audio = audioRef.current;
    if (!audio || !isAudioReady) {
      return;
    }

    const duration = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY;
    audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + deltaSeconds));
    setAudioCurrentTime(audio.currentTime);
  }, [isAudioReady]);

  const toggleAudioPlayback = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !isAudioReady) {
      return;
    }

    try {
      if (audio.paused) {
        await audio.play();
      } else {
        audio.pause();
      }

      setIsAudioPaused(audio.paused);
      setAudioError("");
    } catch (currentError) {
      setIsAudioPaused(audio.paused);
      setAudioError(currentError instanceof Error ? currentError.message : "Audio playback failed.");
    }
  }, [isAudioReady]);

  const handleReaderKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        event.stopPropagation();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        void toggleAudioPlayback();
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        updateTextSize(nextLargerTextSize(textSize));
        return;
      }

      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        updateTextSize(nextSmallerTextSize(textSize));
        return;
      }

      if (event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        seekAudio(10);
        return;
      }

      if (event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        seekAudio(-10);
        return;
      }

      if (event.shiftKey) {
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        navigate("next");
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigate("prev");
      }
    },
    [navigate, seekAudio, textSize, toggleAudioPlayback, updateTextSize],
  );

  const applyTextLayout = useCallback((layout: TextLayout) => {
    const rendition = renditionRef.current;
    if (!rendition) {
      return;
    }

    const currentCfi = rendition.location?.start?.cfi;
    const nextDirection = layout === "horizontal" ? "ltr" : bookDirectionRef.current;
    const currentDirection = (rendition.settings as { direction?: ReadingDirection }).direction;
    const directionChanged = currentDirection !== nextDirection;

    rendition.themes.select(THEME_BY_TEXT_LAYOUT[layout]);
    if (directionChanged) {
      rendition.direction(nextDirection);
      return;
    }

    if (currentCfi) {
      void rendition.display(currentCfi);
    }
  }, []);

  const reflowReader = useCallback((targetCfi?: string | null) => {
    const rendition = renditionRef.current;
    const reader = readerRef.current;
    const cfi = targetCfi ?? rendition?.location?.start?.cfi ?? latestBookCfiRef.current;
    if (!rendition || !reader || !cfi) {
      return;
    }

    window.requestAnimationFrame(() => {
      const width = Math.round(reader.clientWidth);
      const height = Math.round(reader.clientHeight);
      if (width > 0 && height > 0) {
        (rendition as RenditionWithResizeTarget).resize(width, height, cfi);
      } else {
        void rendition.display(cfi);
      }
    });
  }, []);

  const applyTextSize = useCallback((size: number) => {
    const rendition = renditionRef.current;
    if (!rendition) {
      return;
    }

    const currentCfi = rendition.location?.start?.cfi;
    rendition.themes.fontSize(`${size}%`);
    reflowReader(currentCfi);
  }, [reflowReader]);

  const updateForceHorizontal = useCallback((forceHorizontal: boolean) => {
    setSettings((currentSettings) => ({
      ...currentSettings,
      reader: {
        ...currentSettings.reader,
        forceHorizontal,
      },
    }));
  }, []);

  const updatePlaybackRate = useCallback((nextPlaybackRate: number) => {
    setSettings((currentSettings) => ({
      ...currentSettings,
      audio: {
        ...currentSettings.audio,
        playbackRate: normalizePlaybackRate(nextPlaybackRate),
      },
    }));
  }, []);

  const loadEpub = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".epub")) {
        setError("Choose an EPUB file.");
        setLoadState("error");
        return;
      }

      setLoadState("loading");
      setError("");
      setBookName(file.name);
      destroyBook();

      try {
        const bookData = await file.arrayBuffer();
        const fileHash = await hashArrayBuffer(bookData);
        const savedBookProgress = getStoredProgress().books[fileHash];
        bookHashRef.current = fileHash;

        const book = ePub();
        bookRef.current = book;
        await book.open(bookData, "binary");
        const bookWithDirection = book as BookWithDirectionMetadata;
        bookDirectionRef.current = bookWithDirection.package?.metadata?.direction === "rtl" ? "rtl" : "ltr";
        if (textLayout === "horizontal" && bookWithDirection.package?.metadata) {
          bookWithDirection.package.metadata.direction = "ltr";
        }

        if (!readerRef.current) {
          throw new Error("Reader mount failed.");
        }

        const rendition = book.renderTo(readerRef.current, {
          width: "100%",
          height: "100%",
          flow: "paginated",
          manager: "default",
          spread: "none",
        });

        renditionRef.current = rendition;
        rendition.hooks.content.register((contents: Contents) => {
          void contents.addStylesheet(EPUB_FONT_STYLESHEET_URL);
          contents.document.addEventListener("keydown", handleReaderKeyDown);
          void contents.document.fonts?.ready.then(() => {
            if (renditionRef.current === rendition) {
              reflowReader();
            }
          });
        });
        rendition.on("relocated", (location: EpubRelocatedLocation) => {
          const cfi = location.start?.cfi;
          if (cfi) {
            latestBookCfiRef.current = cfi;
          }

          setReaderProgress({
            percentage: typeof location.start?.percentage === "number" ? location.start.percentage : null,
          });
        });

        rendition.themes.register(THEME_BY_TEXT_LAYOUT.book, DARK_READER_THEME);
        rendition.themes.register(THEME_BY_TEXT_LAYOUT.horizontal, HORIZONTAL_READER_THEME);
        applyTextLayout(textLayout);
        applyTextSize(textSize);

        await rendition.display(savedBookProgress?.cfi);
        void book.locations.generate(1600).then(() => {
          if (bookHashRef.current === fileHash && renditionRef.current === rendition) {
            void rendition.reportLocation();
          }
        }).catch(() => {
          // Some EPUBs fail location generation; per-section page display still works.
        });
        setLoadState("ready");
      } catch (currentError) {
        destroyBook();
        setError(currentError instanceof Error ? currentError.message : "The EPUB could not be opened.");
        setLoadState("error");
      }
    },
    [applyTextLayout, applyTextSize, destroyBook, handleReaderKeyDown, reflowReader, textLayout, textSize],
  );

  const handleBookDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      setIsBookDragActive(false);

      const file = event.dataTransfer.files.item(0);
      if (file) {
        void loadEpub(file);
      }
    },
    [loadEpub],
  );

  const loadAudio = useCallback(
    async (file: File) => {
      if (!isAudioFile(file)) {
        setAudioError("Choose an audio file.");
        return;
      }

      destroyAudio();
      const audio = audioRef.current;
      if (!audio) {
        setAudioError("Audio player mount failed.");
        return;
      }

      try {
        const fileHash = await hashArrayBuffer(await file.arrayBuffer());
        const savedAudioProgress = getStoredProgress().audio[fileHash];
        const url = URL.createObjectURL(file);

        audioHashRef.current = fileHash;
        audioUrlRef.current = url;
        audio.src = url;
        audio.playbackRate = playbackRate;
        audio.dataset.resumeTime = `${savedAudioProgress?.currentTime ?? 0}`;
        audio.load();

        setAudioName(file.name);
        setAudioError("");
        setIsAudioReady(true);
        setIsAudioPaused(audio.paused);
      } catch (currentError) {
        destroyAudio();
        setAudioName("");
        setAudioError(currentError instanceof Error ? currentError.message : "The audio file could not be opened.");
      }
    },
    [destroyAudio, playbackRate],
  );

  const handleAudioDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      setIsAudioDragActive(false);

      const file = event.dataTransfer.files.item(0);
      if (file) {
        void loadAudio(file);
      }
    },
    [loadAudio],
  );

  const saveActiveProgress = useCallback(() => {
    saveBookProgress();
    if (audioRef.current) {
      saveAudioProgress(audioRef.current.currentTime);
    }
  }, [saveAudioProgress, saveBookProgress]);

  useEffect(() => {
    window.addEventListener("keydown", handleReaderKeyDown);
    return () => window.removeEventListener("keydown", handleReaderKeyDown);
  }, [handleReaderKeyDown]);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    applyTextLayout(textLayout);
  }, [applyTextLayout, textLayout]);

  useEffect(() => {
    applyTextSize(textSize);
  }, [applyTextSize, textSize]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  useEffect(() => {
    const intervalId = window.setInterval(saveActiveProgress, 5000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        saveActiveProgress();
      }
    };

    window.addEventListener("beforeunload", saveActiveProgress);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("beforeunload", saveActiveProgress);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [saveActiveProgress]);

  useEffect(() => destroyBook, [destroyBook]);
  useEffect(() => destroyAudio, [destroyAudio]);

  const canNavigate = loadState === "ready";
  const hasBook = loadState === "ready";
  const hasAudio = Boolean(audioName);
  const audioProgress = audioDuration > 0 ? (audioCurrentTime / audioDuration) * 100 : 0;
  const readerProgressLabel =
    typeof readerProgress.percentage === "number" ? `${(readerProgress.percentage * 100).toFixed(2)}%` : "";

  return (
    <main className="app-shell">
      <section
        className={`reader-panel ${isBookDragActive ? "drag-active" : ""}`}
        onDragEnter={(event) => {
          if (isFileDrag(event)) {
            setIsBookDragActive(true);
          }
        }}
        onDragOver={(event) => {
          if (isFileDrag(event)) {
            event.preventDefault();
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setIsBookDragActive(false);
          }
        }}
        onDrop={handleBookDrop}
      >
        {hasBook && (
          <header className="reader-bar" aria-label="Reader controls">
            <div className="brand-lockup">
              <span className="brand-mark">SL</span>
              <div>
                <h1>SoundLeaf</h1>
                <div className="reader-meta">
                  <p>{bookName}</p>
                  {readerProgressLabel && <span>{readerProgressLabel}</span>}
                </div>
              </div>
            </div>

            <div className="reader-actions">
              <label className="layout-switch">
                <input
                  checked={textLayout === "horizontal"}
                  type="checkbox"
                  onChange={(event) => updateForceHorizontal(event.currentTarget.checked)}
                />
                <span aria-hidden="true" />
                Force horizontal
              </label>
              <div className="text-size-control" aria-label="Text size">
                <button
                  aria-label="Decrease text size"
                  disabled={textSize <= MIN_TEXT_SIZE}
                  title="Decrease text size (-)"
                  type="button"
                  onClick={() => updateTextSize(nextSmallerTextSize(textSize))}
                >
                  <Minus aria-hidden="true" size={17} />
                </button>
                <button
                  aria-label="Reset text size"
                  className="text-size-value"
                  title="Reset text size"
                  type="button"
                  onClick={() => updateTextSize(DEFAULT_TEXT_SIZE)}
                >
                  {textSize}%
                </button>
                <button
                  aria-label="Increase text size"
                  disabled={textSize >= MAX_TEXT_SIZE}
                  title="Increase text size (+)"
                  type="button"
                  onClick={() => updateTextSize(nextLargerTextSize(textSize))}
                >
                  <Plus aria-hidden="true" size={17} />
                </button>
              </div>
              <button
                aria-label="Previous page"
                className="icon-button"
                disabled={!canNavigate}
                title="Previous page (Left Arrow)"
                type="button"
                onClick={() => navigate("prev")}
              >
                <ChevronLeft aria-hidden="true" size={22} />
              </button>
              <button
                aria-label="Next page"
                className="icon-button"
                disabled={!canNavigate}
                title="Next page (Right Arrow)"
                type="button"
                onClick={() => navigate("next")}
              >
                <ChevronRight aria-hidden="true" size={22} />
              </button>
              <button
                aria-label="Close book"
                className="icon-button"
                title="Close book"
                type="button"
                onClick={() => {
                  saveBookProgress();
                  destroyBook();
                  setBookName("");
                  setError("");
                  setLoadState("empty");
                }}
              >
                <X aria-hidden="true" size={19} />
              </button>
            </div>
          </header>
        )}

        <div className="reader-stage">
          <div
            ref={readerRef}
            className={`epub-host ${loadState === "ready" ? "ready" : ""}`}
            style={{ "--reader-max-width": `${Math.round(384 * (textSize / 100))}px` } as React.CSSProperties}
          />

          {loadState !== "ready" && (
            <div className="drop-prompt">
              {loadState === "loading" ? (
                <Loader2 className="spin" aria-hidden="true" size={34} />
              ) : (
                <FileText aria-hidden="true" size={38} />
              )}
              <div>
                <strong>{loadState === "loading" ? "Opening EPUB" : "Drop EPUB file here"}</strong>
                {error && <span>{error}</span>}
              </div>
            </div>
          )}
        </div>
      </section>

      <section
        className={`audio-drop ${isAudioDragActive ? "drag-active" : ""}`}
        onDragEnter={(event) => {
          if (isFileDrag(event)) {
            setIsAudioDragActive(true);
          }
        }}
        onDragOver={(event) => {
          if (isFileDrag(event)) {
            event.preventDefault();
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setIsAudioDragActive(false);
          }
        }}
        onDrop={handleAudioDrop}
      >
        <audio
          ref={audioRef}
          preload="metadata"
          onDurationChange={(event) => setAudioDuration(event.currentTarget.duration || 0)}
          onEnded={(event) => {
            saveAudioProgress(event.currentTarget.currentTime);
            setIsAudioPaused(event.currentTarget.paused);
          }}
          onError={() => {
            setAudioError("The audio file could not be loaded.");
            setIsAudioReady(false);
            setIsAudioPaused(true);
          }}
          onLoadedMetadata={(event) => {
            const audio = event.currentTarget;
            const duration = audio.duration || 0;
            const resumeTime = Number(audio.dataset.resumeTime);
            delete audio.dataset.resumeTime;

            if (Number.isFinite(resumeTime) && resumeTime > 0 && duration > 0) {
              audio.currentTime = Math.min(resumeTime, Math.max(0, duration - 0.25));
            }

            setAudioDuration(duration);
            setAudioCurrentTime(audio.currentTime);
            setIsAudioPaused(audio.paused);
          }}
          onPause={(event) => {
            saveAudioProgress(event.currentTarget.currentTime);
            setIsAudioPaused(event.currentTarget.paused);
          }}
          onPlay={(event) => setIsAudioPaused(event.currentTarget.paused)}
          onPlaying={(event) => setIsAudioPaused(event.currentTarget.paused)}
          onTimeUpdate={(event) => {
            const audio = event.currentTarget;
            setAudioCurrentTime(audio.currentTime);
          }}
        />

        {hasAudio ? (
          <>
            <FileAudio aria-hidden="true" size={24} />
            <div className="audio-meta">
              <strong>{audioName}</strong>
              <span>
                {audioError ||
                  (isAudioReady ? `${formatTime(audioCurrentTime)} / ${formatTime(audioDuration)}` : "Loading audio")}
              </span>
              <input
                aria-label="Audio position"
                className="audio-seek"
                disabled={!isAudioReady || audioDuration <= 0}
                max={audioDuration || 0}
                min="0"
                step="0.01"
                style={{ "--audio-progress": `${audioProgress}%` } as React.CSSProperties}
                type="range"
                value={Math.min(audioCurrentTime, audioDuration || audioCurrentTime)}
                onBlur={() => {
                  if (audioRef.current) {
                    setAudioCurrentTime(audioRef.current.currentTime);
                    saveAudioProgress(audioRef.current.currentTime);
                  }
                }}
                onChange={(event) => {
                  const nextTime = Number(event.currentTarget.value);
                  if (audioRef.current && Number.isFinite(nextTime)) {
                    audioRef.current.currentTime = nextTime;
                    setAudioCurrentTime(nextTime);
                  }
                }}
                onKeyUp={() => {
                  if (audioRef.current) {
                    saveAudioProgress(audioRef.current.currentTime);
                  }
                }}
                onPointerUp={() => {
                  if (audioRef.current) {
                    saveAudioProgress(audioRef.current.currentTime);
                  }
                }}
              />
            </div>

            <div className="audio-controls" aria-label="Audio controls">
              <div className="playback-rate-control" aria-label="Playback speed">
                <button
                  aria-label="Decrease playback speed"
                  disabled={playbackRate <= MIN_PLAYBACK_RATE}
                  title="Decrease playback speed"
                  type="button"
                  onClick={() => updatePlaybackRate(nextSmallerPlaybackRate(playbackRate))}
                >
                  <Minus aria-hidden="true" size={15} />
                </button>
                <button
                  aria-label="Reset playback speed"
                  className="playback-rate-value"
                  title="Reset playback speed"
                  type="button"
                  onClick={() => updatePlaybackRate(DEFAULT_PLAYBACK_RATE)}
                >
                  {playbackRate.toFixed(2)}x
                </button>
                <button
                  aria-label="Increase playback speed"
                  disabled={playbackRate >= MAX_PLAYBACK_RATE}
                  title="Increase playback speed"
                  type="button"
                  onClick={() => updatePlaybackRate(nextLargerPlaybackRate(playbackRate))}
                >
                  <Plus aria-hidden="true" size={15} />
                </button>
              </div>
              <button
                aria-label="Back 10 seconds"
                className="icon-button"
                disabled={!isAudioReady}
                title="Back 10 seconds (Shift + Left Arrow)"
                type="button"
                onClick={() => seekAudio(-10)}
              >
                <RotateCcw aria-hidden="true" size={19} />
              </button>
              <button
                aria-label={isAudioPaused ? "Play audio" : "Pause audio"}
                className="icon-button audio-play"
                disabled={!isAudioReady}
                title={isAudioPaused ? "Play audio (Space)" : "Pause audio (Space)"}
                type="button"
                onClick={() => {
                  void toggleAudioPlayback();
                }}
              >
                {isAudioPaused ? <Play aria-hidden="true" size={20} /> : <Pause aria-hidden="true" size={20} />}
              </button>
              <button
                aria-label="Forward 10 seconds"
                className="icon-button"
                disabled={!isAudioReady}
                title="Forward 10 seconds (Shift + Right Arrow)"
                type="button"
                onClick={() => seekAudio(10)}
              >
                <RotateCw aria-hidden="true" size={19} />
              </button>
              <button
                aria-label="Remove audio"
                className="icon-button"
                title="Remove audio"
                type="button"
                onClick={() => {
                  if (audioRef.current) {
                    saveAudioProgress(audioRef.current.currentTime);
                  }
                  destroyAudio();
                  setAudioName("");
                  setAudioError("");
                }}
              >
                <X aria-hidden="true" size={19} />
              </button>
            </div>
          </>
        ) : (
          <div className="audio-empty">
            <FileAudio aria-hidden="true" size={24} />
            <strong>{audioError || "Drop audio file here"}</strong>
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
