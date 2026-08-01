import { useCallback, useEffect, useRef, useState } from 'react'
import ePub, { type Book, type Contents, type Rendition } from 'epubjs'
import {
  ChevronLeft,
  ChevronRight,
  FileAudio,
  FileText,
  FolderOpen,
  Loader2,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'

type LoadState = 'empty' | 'loading' | 'ready' | 'error'
type TextLayout = 'book' | 'horizontal'
type ReadingDirection = 'ltr' | 'rtl'
type CachedFileKind = 'epub' | 'audio'

type SoundLeafSettings = {
  reader: {
    forceHorizontal: boolean
    textSize: number
  }
  audio: {
    playbackRate: number
    volume: number
    muted: boolean
    previousVolume: number
  }
}

type SoundLeafProgress = {
  books: Record<string, { cfi: string; name: string; updatedAt: number }>
  audio: Record<string, { currentTime: number; name: string; updatedAt: number }>
}

type ReaderProgress = {
  percentage: number | null
}

type CachedSoundLeafFile = {
  kind: CachedFileKind
  name: string
  type: string
  blob: Blob
  updatedAt: number
}

type EpubRelocatedLocation = {
  start?: {
    cfi?: string
    displayed?: {
      page?: number
      total?: number
    }
    percentage?: number
  }
}

type RenditionWithResizeTarget = Rendition & {
  resize(width: number, height: number, epubcfi?: string): void
}

const THEME_BY_TEXT_LAYOUT: Record<TextLayout, string> = {
  book: 'soundleaf-dark',
  horizontal: 'soundleaf-dark-horizontal',
}

const SETTINGS_STORAGE_KEY = 'soundleaf.settings.v1'
const PROGRESS_STORAGE_KEY = 'soundleaf.progress.v1'
const FILE_DB_NAME = 'soundleaf.files.v1'
const FILE_DB_VERSION = 1
const FILE_STORE_NAME = 'files'
const AUDIO_SKIP_SECONDS = 5
const TEXT_SIZE_OPTIONS = [80, 90, 100, 110, 125, 140, 155, 175, 200, 225, 250, 275, 300, 350, 400] as const
const DEFAULT_TEXT_SIZE = 100
const MIN_TEXT_SIZE = TEXT_SIZE_OPTIONS[0]
const MAX_TEXT_SIZE = TEXT_SIZE_OPTIONS[TEXT_SIZE_OPTIONS.length - 1]
const DEFAULT_PLAYBACK_RATE = 1
const PLAYBACK_RATE_OPTIONS = [
  0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5, 1.6,
  1.7, 1.8, 1.9, 2, 2.2, 2.4, 2.6, 2.8, 3, 3.2, 3.4, 3.6, 3.8, 4,
] as const
const MIN_PLAYBACK_RATE = PLAYBACK_RATE_OPTIONS[0]
const MAX_PLAYBACK_RATE = PLAYBACK_RATE_OPTIONS[PLAYBACK_RATE_OPTIONS.length - 1]
const DEFAULT_AUDIO_VOLUME = 1
const DEFAULT_UNMUTE_VOLUME = 0.5
const DEFAULT_SETTINGS: SoundLeafSettings = {
  reader: {
    forceHorizontal: false,
    textSize: DEFAULT_TEXT_SIZE,
  },
  audio: {
    playbackRate: DEFAULT_PLAYBACK_RATE,
    volume: DEFAULT_AUDIO_VOLUME,
    muted: false,
    previousVolume: DEFAULT_AUDIO_VOLUME,
  },
}
const DEFAULT_PROGRESS: SoundLeafProgress = {
  books: {},
  audio: {},
}

const EPUB_FONT_STYLESHEET_URL = 'https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@400&display=swap'
const DARK_READER_THEME = {
  body: {
    background: '#101214 !important',
    color: '#f2f5f7 !important',
    'font-family': '"M PLUS Rounded 1c", system-ui, sans-serif !important',
    'font-weight': '400 !important',
    'line-height': '1.5 !important',
  },
  'html, body': {
    background: '#101214 !important',
  },
  'a, a:visited': {
    color: '#8cc8ff !important',
  },
  '::selection': {
    background: '#2f6f84 !important',
  },
}
const HORIZONTAL_READER_THEME = {
  ...DARK_READER_THEME,
  'html, body': {
    ...DARK_READER_THEME['html, body'],
    direction: 'ltr !important',
    'text-align': 'left !important',
    'writing-mode': 'horizontal-tb !important',
    '-webkit-writing-mode': 'horizontal-tb !important',
  },
  body: {
    ...DARK_READER_THEME.body,
    direction: 'ltr !important',
    'text-align': 'left !important',
    'writing-mode': 'horizontal-tb !important',
    '-webkit-writing-mode': 'horizontal-tb !important',
  },
  'body, body *': {
    direction: 'ltr !important',
    'text-align': 'left !important',
    'text-orientation': 'mixed !important',
    'writing-mode': 'horizontal-tb !important',
    '-webkit-writing-mode': 'horizontal-tb !important',
  },
}

type BookWithDirectionMetadata = Book & {
  package?: {
    metadata?: {
      direction?: string | null
    }
  }
}

function isFileDrag(event: React.DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes('Files')
}

function isAudioFile(file: File) {
  return file.type.startsWith('audio/') || /\.(aac|aif|aiff|flac|m4a|mp3|ogg|wav|webm)$/i.test(file.name)
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  const tagName = target.tagName.toLowerCase()
  return target.isContentEditable || tagName === 'input' || tagName === 'select' || tagName === 'textarea'
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return '0:00'
  }

  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
    .toString()
    .padStart(2, '0')

  return `${minutes}:${seconds}`
}

function getStoredProgress(): SoundLeafProgress {
  try {
    const storedProgress = window.localStorage.getItem(PROGRESS_STORAGE_KEY)
    if (!storedProgress) {
      return DEFAULT_PROGRESS
    }

    const parsedProgress = JSON.parse(storedProgress) as Partial<SoundLeafProgress>
    return {
      books: parsedProgress.books ?? {},
      audio: parsedProgress.audio ?? {},
    }
  } catch {
    return DEFAULT_PROGRESS
  }
}

function updateStoredProgress(updater: (progress: SoundLeafProgress) => SoundLeafProgress) {
  const nextProgress = updater(getStoredProgress())
  window.localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(nextProgress))
}

function idbRequestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB request failed.')))
  })
}

function idbTransactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve())
    transaction.addEventListener('abort', () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.')),
    )
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('IndexedDB transaction failed.')))
  })
}

async function openFileDb() {
  const request = window.indexedDB.open(FILE_DB_NAME, FILE_DB_VERSION)

  request.addEventListener('upgradeneeded', () => {
    const db = request.result
    if (!db.objectStoreNames.contains(FILE_STORE_NAME)) {
      db.createObjectStore(FILE_STORE_NAME, {
        keyPath: 'kind',
      })
    }
  })

  return idbRequestToPromise(request)
}

async function putCachedFile(kind: CachedFileKind, blob: Blob, name: string, type: string) {
  const db = await openFileDb()

  try {
    const transaction = db.transaction(FILE_STORE_NAME, 'readwrite')
    transaction.objectStore(FILE_STORE_NAME).put({
      kind,
      name,
      type,
      blob,
      updatedAt: Date.now(),
    } satisfies CachedSoundLeafFile)
    await idbTransactionDone(transaction)
  } finally {
    db.close()
  }
}

async function getCachedFile(kind: CachedFileKind) {
  const db = await openFileDb()

  try {
    const transaction = db.transaction(FILE_STORE_NAME, 'readonly')
    const cachedFile = await idbRequestToPromise<CachedSoundLeafFile | undefined>(
      transaction.objectStore(FILE_STORE_NAME).get(kind),
    )
    await idbTransactionDone(transaction)
    return cachedFile ?? null
  } finally {
    db.close()
  }
}

async function deleteCachedFile(kind: CachedFileKind) {
  const db = await openFileDb()

  try {
    const transaction = db.transaction(FILE_STORE_NAME, 'readwrite')
    transaction.objectStore(FILE_STORE_NAME).delete(kind)
    await idbTransactionDone(transaction)
  } finally {
    db.close()
  }
}

async function hashArrayBuffer(buffer: ArrayBuffer) {
  const digest = await window.crypto.subtle.digest('SHA-256', buffer)
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function nearestOption(value: number, options: readonly number[]) {
  return options.reduce((nearestValue, option) =>
    Math.abs(option - value) < Math.abs(nearestValue - value) ? option : nearestValue,
  )
}

function nextLargerTextSize(size: number) {
  return TEXT_SIZE_OPTIONS.find(option => option > size) ?? MAX_TEXT_SIZE
}

function nextSmallerTextSize(size: number) {
  return [...TEXT_SIZE_OPTIONS].reverse().find(option => option < size) ?? MIN_TEXT_SIZE
}

function normalizeTextSize(size: number) {
  return nearestOption(size, TEXT_SIZE_OPTIONS)
}

function normalizePlaybackRate(rate: number) {
  return nearestOption(rate, PLAYBACK_RATE_OPTIONS)
}

function normalizeAudioVolume(volume: number) {
  if (!Number.isFinite(volume)) {
    return DEFAULT_AUDIO_VOLUME
  }

  return Math.max(0, Math.min(1, volume))
}

function getRestorableAudioVolume(volume: number) {
  return volume > 0 ? volume : DEFAULT_UNMUTE_VOLUME
}

function nextLargerPlaybackRate(rate: number) {
  return PLAYBACK_RATE_OPTIONS.find(option => option > rate) ?? MAX_PLAYBACK_RATE
}

function nextSmallerPlaybackRate(rate: number) {
  return [...PLAYBACK_RATE_OPTIONS].reverse().find(option => option < rate) ?? MIN_PLAYBACK_RATE
}

function getInitialSettings(): SoundLeafSettings {
  try {
    const storedSettings = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!storedSettings) {
      return DEFAULT_SETTINGS
    }

    const parsedSettings = JSON.parse(storedSettings) as Partial<SoundLeafSettings>
    const storedVolume = normalizeAudioVolume(
      typeof parsedSettings.audio?.volume === 'number' ? parsedSettings.audio.volume : DEFAULT_AUDIO_VOLUME,
    )
    const storedPreviousVolume = normalizeAudioVolume(
      typeof parsedSettings.audio?.previousVolume === 'number'
        ? parsedSettings.audio.previousVolume
        : DEFAULT_AUDIO_VOLUME,
    )
    const volume = parsedSettings.audio?.muted === true ? 0 : storedVolume
    return {
      reader: {
        forceHorizontal: parsedSettings.reader?.forceHorizontal === true,
        textSize: normalizeTextSize(
          typeof parsedSettings.reader?.textSize === 'number' ? parsedSettings.reader.textSize : DEFAULT_TEXT_SIZE,
        ),
      },
      audio: {
        playbackRate: normalizePlaybackRate(
          typeof parsedSettings.audio?.playbackRate === 'number'
            ? parsedSettings.audio.playbackRate
            : DEFAULT_PLAYBACK_RATE,
        ),
        volume,
        muted: volume === 0,
        previousVolume: getRestorableAudioVolume(volume > 0 ? volume : storedPreviousVolume),
      },
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function App() {
  const readerRef = useRef<HTMLDivElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const bookInputRef = useRef<HTMLInputElement | null>(null)
  const audioInputRef = useRef<HTMLInputElement | null>(null)
  const bookRef = useRef<Book | null>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const bookDirectionRef = useRef<ReadingDirection>('ltr')
  const bookHashRef = useRef<string | null>(null)
  const audioHashRef = useRef<string | null>(null)
  const latestBookCfiRef = useRef<string | null>(null)
  const areBookLocationsReadyRef = useRef(false)
  const bookJumpRequestIdRef = useRef(0)

  const [bookName, setBookName] = useState('')
  const [audioName, setAudioName] = useState('')
  const [loadState, setLoadState] = useState<LoadState>('empty')
  const [audioLoadState, setAudioLoadState] = useState<LoadState>('empty')
  const [isBookDragActive, setIsBookDragActive] = useState(false)
  const [isAudioDragActive, setIsAudioDragActive] = useState(false)
  const [isAudioReady, setIsAudioReady] = useState(false)
  const [isAudioPaused, setIsAudioPaused] = useState(true)
  const [audioCurrentTime, setAudioCurrentTime] = useState(0)
  const [audioDuration, setAudioDuration] = useState(0)
  const [settings, setSettings] = useState<SoundLeafSettings>(getInitialSettings)
  const [readerProgress, setReaderProgress] = useState<ReaderProgress>({
    percentage: null,
  })
  const [error, setError] = useState('')
  const [audioError, setAudioError] = useState('')
  const [canClearCachedBook, setCanClearCachedBook] = useState(false)
  const [canClearCachedAudio, setCanClearCachedAudio] = useState(false)

  const textLayout: TextLayout = settings.reader.forceHorizontal ? 'horizontal' : 'book'
  const textSize = settings.reader.textSize
  const playbackRate = settings.audio.playbackRate
  const audioVolume = settings.audio.volume
  const isAudioMuted = audioVolume === 0

  const destroyBook = useCallback(() => {
    renditionRef.current?.destroy()
    renditionRef.current = null

    bookRef.current?.destroy()
    bookRef.current = null
    bookDirectionRef.current = 'ltr'
    bookHashRef.current = null
    latestBookCfiRef.current = null
    areBookLocationsReadyRef.current = false
    bookJumpRequestIdRef.current += 1
    setReaderProgress({
      percentage: null,
    })

    if (readerRef.current) {
      readerRef.current.replaceChildren()
    }
  }, [])

  const destroyAudio = useCallback(() => {
    const audio = audioRef.current

    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }

    audioHashRef.current = null
    setIsAudioReady(false)
    setIsAudioPaused(true)
    setAudioCurrentTime(0)
    setAudioDuration(0)
    setAudioLoadState('empty')
  }, [])

  const navigate = useCallback(
    (direction: 'prev' | 'next') => {
      const rendition = renditionRef.current
      if (!rendition) {
        return
      }

      const shouldInvert = textLayout === 'book' && bookDirectionRef.current === 'rtl'
      const action = shouldInvert ? (direction === 'next' ? 'prev' : 'next') : direction

      if (action === 'next') {
        void rendition.next()
      } else {
        void rendition.prev()
      }
    },
    [textLayout],
  )

  const jumpToBookPercentage = useCallback(async (percentage: number) => {
    const book = bookRef.current
    const rendition = renditionRef.current
    if (!book || !rendition || !areBookLocationsReadyRef.current) {
      return
    }

    const targetCfi = book.locations.cfiFromPercentage(Math.max(0, Math.min(1, percentage)))
    if (targetCfi) {
      const requestId = bookJumpRequestIdRef.current + 1
      bookJumpRequestIdRef.current = requestId

      try {
        await rendition.display(targetCfi)
        window.requestAnimationFrame(() => {
          if (bookJumpRequestIdRef.current === requestId && renditionRef.current === rendition) {
            void rendition.display(targetCfi)
          }
        })
      } catch {
        // Ignore failed percentage jumps; normal page controls still work.
      }
    }
  }, [])

  const saveAudioProgress = useCallback(
    (currentTime: number) => {
      const currentHash = audioHashRef.current
      if (!currentHash || !audioName || !Number.isFinite(currentTime)) {
        return
      }

      updateStoredProgress(progress => ({
        ...progress,
        audio: {
          ...progress.audio,
          [currentHash]: {
            currentTime,
            name: audioName,
            updatedAt: Date.now(),
          },
        },
      }))
    },
    [audioName],
  )

  const saveBookProgress = useCallback(() => {
    const currentHash = bookHashRef.current
    const cfi = latestBookCfiRef.current
    if (!currentHash || !bookName || !cfi) {
      return
    }

    updateStoredProgress(progress => ({
      ...progress,
      books: {
        ...progress.books,
        [currentHash]: {
          cfi,
          name: bookName,
          updatedAt: Date.now(),
        },
      },
    }))
  }, [bookName])

  const updateTextSize = useCallback((nextSize: number) => {
    setSettings(currentSettings => ({
      ...currentSettings,
      reader: {
        ...currentSettings.reader,
        textSize: normalizeTextSize(nextSize),
      },
    }))
  }, [])

  const seekAudio = useCallback(
    (deltaSeconds: number) => {
      const audio = audioRef.current
      if (!audio || !isAudioReady) {
        return
      }

      const duration = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY
      audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + deltaSeconds))
      setAudioCurrentTime(audio.currentTime)
    },
    [isAudioReady],
  )

  const toggleAudioPlayback = useCallback(async () => {
    const audio = audioRef.current
    if (!audio || !isAudioReady) {
      return
    }

    try {
      if (audio.paused) {
        await audio.play()
      } else {
        audio.pause()
      }

      setIsAudioPaused(audio.paused)
      setAudioError('')
    } catch (currentError) {
      setIsAudioPaused(audio.paused)
      setAudioError(currentError instanceof Error ? currentError.message : 'Audio playback failed.')
    }
  }, [isAudioReady])

  const handleReaderKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault()
        event.stopPropagation()
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
        void toggleAudioPlayback()
        return
      }

      if (isEditableTarget(event.target)) {
        return
      }

      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        updateTextSize(nextLargerTextSize(textSize))
        return
      }

      if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        updateTextSize(nextSmallerTextSize(textSize))
        return
      }

      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault()
        jumpToBookPercentage(Number(event.key) / 10)
        return
      }

      if (event.shiftKey && event.key === 'ArrowRight') {
        event.preventDefault()
        seekAudio(AUDIO_SKIP_SECONDS)
        return
      }

      if (event.shiftKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        seekAudio(-AUDIO_SKIP_SECONDS)
        return
      }

      if (event.shiftKey) {
        return
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        navigate('next')
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        navigate('prev')
      }
    },
    [jumpToBookPercentage, navigate, seekAudio, textSize, toggleAudioPlayback, updateTextSize],
  )

  const applyTextLayout = useCallback((layout: TextLayout) => {
    const rendition = renditionRef.current
    if (!rendition) {
      return
    }

    const currentCfi = rendition.location?.start?.cfi
    const nextDirection = layout === 'horizontal' ? 'ltr' : bookDirectionRef.current
    const currentDirection = (rendition.settings as { direction?: ReadingDirection }).direction
    const directionChanged = currentDirection !== nextDirection

    rendition.themes.select(THEME_BY_TEXT_LAYOUT[layout])
    if (directionChanged) {
      rendition.direction(nextDirection)
      return
    }

    if (currentCfi) {
      void rendition.display(currentCfi)
    }
  }, [])

  const reflowReader = useCallback((targetCfi?: string | null) => {
    const rendition = renditionRef.current
    const reader = readerRef.current
    const cfi = targetCfi ?? rendition?.location?.start?.cfi ?? latestBookCfiRef.current
    if (!rendition || !reader || !cfi) {
      return
    }

    window.requestAnimationFrame(() => {
      const width = Math.round(reader.clientWidth)
      const height = Math.round(reader.clientHeight)
      if (width > 0 && height > 0) {
        ;(rendition as RenditionWithResizeTarget).resize(width, height, cfi)
      } else {
        void rendition.display(cfi)
      }
    })
  }, [])

  const applyTextSize = useCallback(
    (size: number) => {
      const rendition = renditionRef.current
      if (!rendition) {
        return
      }

      const currentCfi = rendition.location?.start?.cfi
      rendition.themes.fontSize(`${size}%`)
      reflowReader(currentCfi)
    },
    [reflowReader],
  )

  const updateForceHorizontal = useCallback((forceHorizontal: boolean) => {
    setSettings(currentSettings => ({
      ...currentSettings,
      reader: {
        ...currentSettings.reader,
        forceHorizontal,
      },
    }))
  }, [])

  const updatePlaybackRate = useCallback((nextPlaybackRate: number) => {
    setSettings(currentSettings => ({
      ...currentSettings,
      audio: {
        ...currentSettings.audio,
        playbackRate: normalizePlaybackRate(nextPlaybackRate),
      },
    }))
  }, [])

  const updateAudioVolume = useCallback((nextVolume: number) => {
    setSettings(currentSettings => {
      const volume = normalizeAudioVolume(nextVolume)
      return {
        ...currentSettings,
        audio: {
          ...currentSettings.audio,
          volume,
          muted: volume === 0,
          previousVolume: volume > 0 ? volume : DEFAULT_UNMUTE_VOLUME,
        },
      }
    })
  }, [])

  const updateAudioMuted = useCallback((muted: boolean) => {
    setSettings(currentSettings => {
      const currentVolume = normalizeAudioVolume(currentSettings.audio.volume)
      const previousVolume = getRestorableAudioVolume(currentSettings.audio.previousVolume)
      const volume = muted ? 0 : previousVolume

      return {
        ...currentSettings,
        audio: {
          ...currentSettings.audio,
          volume,
          muted: volume === 0,
          previousVolume: muted && currentVolume > 0 ? currentVolume : previousVolume,
        },
      }
    })
  }, [])

  const loadEpubFromBlob = useCallback(
    async (blob: Blob, name: string, canClearCacheOnError = false) => {
      setLoadState('loading')
      setError('')
      setCanClearCachedBook(false)
      setBookName(name)
      destroyBook()

      try {
        const bookData = await blob.arrayBuffer()
        const fileHash = await hashArrayBuffer(bookData)
        const savedBookProgress = getStoredProgress().books[fileHash]
        bookHashRef.current = fileHash

        const book = ePub()
        bookRef.current = book
        await book.open(bookData, 'binary')
        const bookWithDirection = book as BookWithDirectionMetadata
        bookDirectionRef.current = bookWithDirection.package?.metadata?.direction === 'rtl' ? 'rtl' : 'ltr'
        if (textLayout === 'horizontal' && bookWithDirection.package?.metadata) {
          bookWithDirection.package.metadata.direction = 'ltr'
        }

        if (!readerRef.current) {
          throw new Error('Reader mount failed.')
        }

        const rendition = book.renderTo(readerRef.current, {
          width: '100%',
          height: '100%',
          flow: 'paginated',
          manager: 'default',
          spread: 'none',
        })

        renditionRef.current = rendition
        rendition.hooks.content.register((contents: Contents) => {
          void contents.addStylesheet(EPUB_FONT_STYLESHEET_URL)
          contents.document.addEventListener('keydown', handleReaderKeyDown)
          void contents.document.fonts?.ready.then(() => {
            if (renditionRef.current === rendition) {
              reflowReader()
            }
          })
        })
        rendition.on('relocated', (location: EpubRelocatedLocation) => {
          const cfi = location.start?.cfi
          if (cfi) {
            latestBookCfiRef.current = cfi
          }

          setReaderProgress({
            percentage: typeof location.start?.percentage === 'number' ? location.start.percentage : null,
          })
        })

        rendition.themes.register(THEME_BY_TEXT_LAYOUT.book, DARK_READER_THEME)
        rendition.themes.register(THEME_BY_TEXT_LAYOUT.horizontal, HORIZONTAL_READER_THEME)
        applyTextLayout(textLayout)
        applyTextSize(textSize)

        await rendition.display(savedBookProgress?.cfi)
        void book.locations
          .generate(1600)
          .then(() => {
            if (bookHashRef.current === fileHash && renditionRef.current === rendition) {
              areBookLocationsReadyRef.current = true
              void rendition.reportLocation()
            }
          })
          .catch(() => {
            areBookLocationsReadyRef.current = false
            // Some EPUBs fail location generation; the whole-book percentage can stay unavailable.
          })
        setLoadState('ready')
      } catch (currentError) {
        destroyBook()
        setError(currentError instanceof Error ? currentError.message : 'The EPUB could not be opened.')
        setCanClearCachedBook(canClearCacheOnError)
        setLoadState('error')
      }
    },
    [applyTextLayout, applyTextSize, destroyBook, handleReaderKeyDown, reflowReader, textLayout, textSize],
  )

  const loadEpub = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith('.epub')) {
        setError('Choose an EPUB file.')
        setCanClearCachedBook(false)
        if (!bookName) {
          setLoadState('error')
        }
        return
      }

      setLoadState('loading')
      setError('')
      setCanClearCachedBook(false)
      setBookName(file.name)
      destroyBook()

      try {
        await putCachedFile('epub', file, file.name, file.type || 'application/epub+zip')
        const cachedFile = await getCachedFile('epub')
        if (!cachedFile) {
          throw new Error('The EPUB could not be saved in this browser.')
        }

        await loadEpubFromBlob(cachedFile.blob, cachedFile.name, true)
      } catch (currentError) {
        destroyBook()
        setError(currentError instanceof Error ? currentError.message : 'The EPUB could not be saved in this browser.')
        setCanClearCachedBook(true)
        setLoadState('error')
      }
    },
    [bookName, destroyBook, loadEpubFromBlob],
  )

  const handleBookDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault()
      setIsBookDragActive(false)

      const file = event.dataTransfer.files.item(0)
      if (file) {
        void loadEpub(file)
      }
    },
    [loadEpub],
  )

  const handleBookInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.item(0)
      event.currentTarget.value = ''
      if (file) {
        void loadEpub(file)
      }
    },
    [loadEpub],
  )

  const loadAudioFromBlob = useCallback(
    async (blob: Blob, name: string, canClearCacheOnError = false) => {
      destroyAudio()
      setAudioLoadState('loading')
      setAudioName(name)
      setAudioError('')
      setCanClearCachedAudio(false)
      const audio = audioRef.current
      if (!audio) {
        setAudioError('Audio player mount failed.')
        setCanClearCachedAudio(canClearCacheOnError)
        setAudioLoadState('error')
        return
      }

      try {
        const fileHash = await hashArrayBuffer(await blob.arrayBuffer())
        const savedAudioProgress = getStoredProgress().audio[fileHash]
        const url = URL.createObjectURL(blob)

        audioHashRef.current = fileHash
        audioUrlRef.current = url
        audio.src = url
        audio.playbackRate = playbackRate
        audio.volume = audioVolume
        audio.muted = isAudioMuted
        audio.dataset.resumeTime = `${savedAudioProgress?.currentTime ?? 0}`
        audio.load()

        setIsAudioReady(false)
        setIsAudioPaused(audio.paused)
      } catch (currentError) {
        destroyAudio()
        setAudioName('')
        setAudioError(currentError instanceof Error ? currentError.message : 'The audio file could not be opened.')
        setCanClearCachedAudio(canClearCacheOnError)
        setAudioLoadState('error')
      }
    },
    [audioVolume, destroyAudio, isAudioMuted, playbackRate],
  )

  const loadAudio = useCallback(
    async (file: File) => {
      if (!isAudioFile(file)) {
        setAudioError('Choose an audio file.')
        setCanClearCachedAudio(false)
        if (!audioName) {
          setAudioLoadState('error')
        }
        return
      }

      destroyAudio()
      setAudioLoadState('loading')
      setAudioName('')
      setAudioError('')
      setCanClearCachedAudio(false)

      try {
        await putCachedFile('audio', file, file.name, file.type || 'application/octet-stream')
        const cachedFile = await getCachedFile('audio')
        if (!cachedFile) {
          throw new Error('The audio file could not be saved in this browser.')
        }

        await loadAudioFromBlob(cachedFile.blob, cachedFile.name, true)
      } catch (currentError) {
        destroyAudio()
        setAudioName('')
        setAudioError(
          currentError instanceof Error ? currentError.message : 'The audio file could not be saved in this browser.',
        )
        setCanClearCachedAudio(true)
        setAudioLoadState('error')
      }
    },
    [audioName, destroyAudio, loadAudioFromBlob],
  )

  const handleAudioDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault()
      setIsAudioDragActive(false)

      const file = event.dataTransfer.files.item(0)
      if (file) {
        void loadAudio(file)
      }
    },
    [loadAudio],
  )

  const handleAudioInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.item(0)
      event.currentTarget.value = ''
      if (file) {
        void loadAudio(file)
      }
    },
    [loadAudio],
  )

  const saveActiveProgress = useCallback(() => {
    saveBookProgress()
    if (audioRef.current) {
      saveAudioProgress(audioRef.current.currentTime)
    }
  }, [saveAudioProgress, saveBookProgress])

  const removeBook = useCallback(async () => {
    saveBookProgress()

    try {
      await deleteCachedFile('epub')
      setError('')
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : 'The cached EPUB could not be removed.')
    }

    destroyBook()
    setBookName('')
    setCanClearCachedBook(false)
    setLoadState('empty')
  }, [destroyBook, saveBookProgress])

  const removeAudio = useCallback(async () => {
    if (audioRef.current) {
      saveAudioProgress(audioRef.current.currentTime)
    }

    try {
      await deleteCachedFile('audio')
      setAudioError('')
    } catch (currentError) {
      setAudioError(
        currentError instanceof Error ? currentError.message : 'The cached audio file could not be removed.',
      )
    }

    destroyAudio()
    setAudioName('')
    setCanClearCachedAudio(false)
    setAudioLoadState('empty')
  }, [destroyAudio, saveAudioProgress])

  const clearCachedBook = useCallback(async () => {
    try {
      await deleteCachedFile('epub')
      setError('')
      setCanClearCachedBook(false)
      setLoadState('empty')
      destroyBook()
      setBookName('')
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : 'The cached EPUB could not be cleared.')
      setCanClearCachedBook(true)
    }
  }, [destroyBook])

  const clearCachedAudio = useCallback(async () => {
    try {
      await deleteCachedFile('audio')
      setAudioError('')
      setCanClearCachedAudio(false)
      setAudioLoadState('empty')
      destroyAudio()
      setAudioName('')
    } catch (currentError) {
      setAudioError(
        currentError instanceof Error ? currentError.message : 'The cached audio file could not be cleared.',
      )
      setCanClearCachedAudio(true)
    }
  }, [destroyAudio])

  useEffect(() => {
    window.addEventListener('keydown', handleReaderKeyDown)
    return () => window.removeEventListener('keydown', handleReaderKeyDown)
  }, [handleReaderKeyDown])

  useEffect(() => {
    let isCancelled = false

    const restoreCachedFiles = async () => {
      try {
        const [cachedBook, cachedAudio] = await Promise.all([getCachedFile('epub'), getCachedFile('audio')])
        if (isCancelled) {
          return
        }

        if (cachedBook) {
          void loadEpubFromBlob(cachedBook.blob, cachedBook.name, true)
        }

        if (cachedAudio) {
          void loadAudioFromBlob(cachedAudio.blob, cachedAudio.name, true)
        }
      } catch (currentError) {
        if (!isCancelled) {
          const message =
            currentError instanceof Error ? currentError.message : 'Cached files could not be loaded from this browser.'
          setError(message)
          setAudioError(message)
          setCanClearCachedBook(true)
          setCanClearCachedAudio(true)
        }
      }
    }

    void restoreCachedFiles()

    return () => {
      isCancelled = true
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    applyTextLayout(textLayout)
  }, [applyTextLayout, textLayout])

  useEffect(() => {
    applyTextSize(textSize)
  }, [applyTextSize, textSize])

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate
    }
  }, [playbackRate])

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = audioVolume
      audioRef.current.muted = isAudioMuted
    }
  }, [audioVolume, isAudioMuted])

  useEffect(() => {
    const intervalId = window.setInterval(saveActiveProgress, 5000)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveActiveProgress()
      }
    }

    window.addEventListener('beforeunload', saveActiveProgress)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('beforeunload', saveActiveProgress)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [saveActiveProgress])

  useEffect(() => destroyBook, [destroyBook])
  useEffect(() => destroyAudio, [destroyAudio])

  const canNavigate = loadState === 'ready'
  const hasBook = loadState === 'ready'
  const isAudioLoading = audioLoadState === 'loading'
  const hasAudio = audioLoadState === 'ready' && Boolean(audioName)
  const audioProgress = audioDuration > 0 ? (audioCurrentTime / audioDuration) * 100 : 0
  const readerProgressLabel =
    typeof readerProgress.percentage === 'number' ? `${(readerProgress.percentage * 100).toFixed(2)}%` : ''

  return (
    <main className="app-shell">
      <input
        ref={bookInputRef}
        accept=".epub,application/epub+zip"
        className="file-input"
        type="file"
        onChange={handleBookInputChange}
      />
      <input
        ref={audioInputRef}
        accept="audio/*,.aac,.aif,.aiff,.flac,.m4a,.mp3,.ogg,.wav,.webm"
        className="file-input"
        type="file"
        onChange={handleAudioInputChange}
      />
      <section
        className={`reader-panel ${isBookDragActive ? 'drag-active' : ''}`}
        onDragEnter={event => {
          if (isFileDrag(event)) {
            setIsBookDragActive(true)
          }
        }}
        onDragOver={event => {
          if (isFileDrag(event)) {
            event.preventDefault()
          }
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setIsBookDragActive(false)
          }
        }}
        onDrop={handleBookDrop}
      >
        {hasBook && (
          <header className="reader-bar" aria-label="Reader controls">
            <div className="brand-lockup">
              <span className="brand-mark">SL</span>
              <div>
                <h1>{bookName}</h1>
                <div className="reader-meta">{readerProgressLabel && <p>{readerProgressLabel}</p>}</div>
              </div>
            </div>

            <div className="reader-actions">
              <label className="layout-switch">
                <input
                  checked={textLayout === 'horizontal'}
                  type="checkbox"
                  onChange={event => updateForceHorizontal(event.currentTarget.checked)}
                />
                <span aria-hidden="true" />
                Force LTR
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
                onClick={() => navigate('prev')}
              >
                <ChevronLeft aria-hidden="true" size={22} />
              </button>
              <button
                aria-label="Next page"
                className="icon-button"
                disabled={!canNavigate}
                title="Next page (Right Arrow)"
                type="button"
                onClick={() => navigate('next')}
              >
                <ChevronRight aria-hidden="true" size={22} />
              </button>
              <button
                aria-label="Close book"
                className="icon-button"
                title="Close book"
                type="button"
                onClick={() => {
                  void removeBook()
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
            className={`epub-host ${loadState === 'ready' ? 'ready' : ''}`}
            style={{ '--reader-max-width': `${Math.round(384 * (textSize / 100))}px` } as React.CSSProperties}
          />

          {hasBook && (
            <div className="page-tap-zones" aria-label="Page navigation">
              <button
                aria-label="Previous page"
                className="page-tap-zone page-tap-zone-left"
                tabIndex={-1}
                title="Previous page (Left Arrow)"
                type="button"
                onMouseDown={event => event.preventDefault()}
                onClick={() => navigate('prev')}
              >
                <ChevronLeft aria-hidden="true" size={38} />
              </button>
              <button
                aria-label="Next page"
                className="page-tap-zone page-tap-zone-right"
                tabIndex={-1}
                title="Next page (Right Arrow)"
                type="button"
                onMouseDown={event => event.preventDefault()}
                onClick={() => navigate('next')}
              >
                <ChevronRight aria-hidden="true" size={38} />
              </button>
            </div>
          )}

          {loadState !== 'ready' && (
            <div className="drop-prompt">
              {loadState === 'loading' ? (
                <Loader2 className="spin" aria-hidden="true" size={34} />
              ) : (
                <FileText aria-hidden="true" size={38} />
              )}
              <div>
                <strong>{loadState === 'loading' ? 'Opening EPUB' : 'Drop EPUB file here'}</strong>
                {error && <span>{error}</span>}
                {loadState !== 'loading' && (
                  <div className="drop-actions">
                    <button className="file-open-button" type="button" onClick={() => bookInputRef.current?.click()}>
                      <FolderOpen aria-hidden="true" size={17} />
                      Open EPUB
                    </button>
                    {canClearCachedBook && (
                      <button className="cache-clear-button" type="button" onClick={() => void clearCachedBook()}>
                        <X aria-hidden="true" size={16} />
                        Clear cached EPUB
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <section
        className={`audio-drop ${isAudioDragActive ? 'drag-active' : ''}`}
        onDragEnter={event => {
          if (isFileDrag(event)) {
            setIsAudioDragActive(true)
          }
        }}
        onDragOver={event => {
          if (isFileDrag(event)) {
            event.preventDefault()
          }
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setIsAudioDragActive(false)
          }
        }}
        onDrop={handleAudioDrop}
      >
        <audio
          ref={audioRef}
          preload="metadata"
          onDurationChange={event => setAudioDuration(event.currentTarget.duration || 0)}
          onEnded={event => {
            saveAudioProgress(event.currentTarget.currentTime)
            setIsAudioPaused(event.currentTarget.paused)
          }}
          onError={() => {
            setAudioError('The audio file could not be loaded.')
            setAudioName('')
            setIsAudioReady(false)
            setIsAudioPaused(true)
            setAudioLoadState('error')
          }}
          onLoadedMetadata={event => {
            const audio = event.currentTarget
            const duration = audio.duration || 0
            const resumeTime = Number(audio.dataset.resumeTime)
            delete audio.dataset.resumeTime

            if (Number.isFinite(resumeTime) && resumeTime > 0 && duration > 0) {
              audio.currentTime = Math.min(resumeTime, Math.max(0, duration - 0.25))
            }

            setAudioDuration(duration)
            setAudioCurrentTime(audio.currentTime)
            setIsAudioReady(true)
            setIsAudioPaused(audio.paused)
            setAudioLoadState('ready')
          }}
          onPause={event => {
            saveAudioProgress(event.currentTarget.currentTime)
            setIsAudioPaused(event.currentTarget.paused)
          }}
          onPlay={event => setIsAudioPaused(event.currentTarget.paused)}
          onPlaying={event => setIsAudioPaused(event.currentTarget.paused)}
          onTimeUpdate={event => {
            const audio = event.currentTarget
            setAudioCurrentTime(audio.currentTime)
          }}
        />

        {isAudioLoading ? (
          <div className="audio-empty">
            <Loader2 className="spin" aria-hidden="true" size={24} />
            <div>
              <strong>Opening audio</strong>
              {audioName && <span>{audioName}</span>}
            </div>
          </div>
        ) : hasAudio ? (
          <div className="audio-player">
            <strong className="audio-title">{audioName}</strong>
            <input
              aria-label="Audio position"
              className="audio-seek"
              disabled={!isAudioReady || audioDuration <= 0}
              max={audioDuration || 0}
              min="0"
              step="0.01"
              style={{ '--audio-progress': `${audioProgress}%` } as React.CSSProperties}
              type="range"
              value={Math.min(audioCurrentTime, audioDuration || audioCurrentTime)}
              onBlur={() => {
                if (audioRef.current) {
                  setAudioCurrentTime(audioRef.current.currentTime)
                  saveAudioProgress(audioRef.current.currentTime)
                }
              }}
              onChange={event => {
                const nextTime = Number(event.currentTarget.value)
                if (audioRef.current && Number.isFinite(nextTime)) {
                  audioRef.current.currentTime = nextTime
                  setAudioCurrentTime(nextTime)
                }
              }}
              onKeyUp={() => {
                if (audioRef.current) {
                  saveAudioProgress(audioRef.current.currentTime)
                }
              }}
              onPointerUp={() => {
                if (audioRef.current) {
                  saveAudioProgress(audioRef.current.currentTime)
                }
              }}
            />

            <div className="audio-footer">
              <span className="audio-time">
                {audioError ||
                  (isAudioReady ? `${formatTime(audioCurrentTime)} / ${formatTime(audioDuration)}` : 'Loading audio')}
              </span>

              <div className="audio-transport" aria-label="Audio playback controls">
                <button
                  aria-label={`Back ${AUDIO_SKIP_SECONDS} seconds`}
                  className="icon-button"
                  disabled={!isAudioReady}
                  title={`Back ${AUDIO_SKIP_SECONDS} seconds (Shift + Left Arrow)`}
                  type="button"
                  onClick={() => seekAudio(-AUDIO_SKIP_SECONDS)}
                >
                  <RotateCcw aria-hidden="true" size={19} />
                </button>
                <button
                  aria-label={isAudioPaused ? 'Play audio' : 'Pause audio'}
                  className="icon-button audio-play"
                  disabled={!isAudioReady}
                  title={isAudioPaused ? 'Play audio (Space)' : 'Pause audio (Space)'}
                  type="button"
                  onClick={() => {
                    void toggleAudioPlayback()
                  }}
                >
                  {isAudioPaused ? <Play aria-hidden="true" size={20} /> : <Pause aria-hidden="true" size={20} />}
                </button>
                <button
                  aria-label={`Forward ${AUDIO_SKIP_SECONDS} seconds`}
                  className="icon-button"
                  disabled={!isAudioReady}
                  title={`Forward ${AUDIO_SKIP_SECONDS} seconds (Shift + Right Arrow)`}
                  type="button"
                  onClick={() => seekAudio(AUDIO_SKIP_SECONDS)}
                >
                  <RotateCw aria-hidden="true" size={19} />
                </button>
              </div>

              <div className="audio-secondary-controls" aria-label="Audio settings">
                <div className="volume-control" aria-label="Volume">
                  <button
                    aria-label={isAudioMuted ? 'Unmute audio' : 'Mute audio'}
                    className="icon-button volume-toggle"
                    title={isAudioMuted ? 'Unmute audio' : 'Mute audio'}
                    type="button"
                    onClick={() => updateAudioMuted(!isAudioMuted)}
                  >
                    {isAudioMuted || audioVolume === 0 ? (
                      <VolumeX aria-hidden="true" size={18} />
                    ) : (
                      <Volume2 aria-hidden="true" size={18} />
                    )}
                  </button>
                  <input
                    aria-label="Audio volume"
                    className="volume-slider"
                    max="1"
                    min="0"
                    step="0.01"
                    style={{ '--volume-level': `${audioVolume * 100}%` } as React.CSSProperties}
                    type="range"
                    value={audioVolume}
                    onChange={event => {
                      const nextVolume = Number(event.currentTarget.value)
                      updateAudioVolume(nextVolume)
                    }}
                  />
                </div>
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
                  aria-label="Remove audio"
                  className="icon-button"
                  title="Remove audio"
                  type="button"
                  onClick={() => {
                    void removeAudio()
                  }}
                >
                  <X aria-hidden="true" size={19} />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="audio-empty">
            <FileAudio aria-hidden="true" size={24} />
            <div>
              <strong>Drop audio file here</strong>
              {audioError && <span>{audioError}</span>}
            </div>
            <button className="file-open-button" type="button" onClick={() => audioInputRef.current?.click()}>
              <FolderOpen aria-hidden="true" size={17} />
              Open audio
            </button>
            {canClearCachedAudio && (
              <button className="cache-clear-button" type="button" onClick={() => void clearCachedAudio()}>
                <X aria-hidden="true" size={16} />
                Clear cached audio
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  )
}

export default App
