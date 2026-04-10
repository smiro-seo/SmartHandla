# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # Install dependencies
npm run dev        # Start dev server at http://localhost:3000
npm run build      # Production build
npm run preview    # Preview production build
```

There are no test or lint scripts configured.

## Environment

Requires a `.env.local` file with:
```
GEMINI_API_KEY=your_google_genai_key_here
```

The Vite config exposes this as both `process.env.API_KEY` and `process.env.GEMINI_API_KEY` at build time.

## Architecture

The app is a single-page React app with three layers:

**UI (`App.tsx`)** — Monolithic component (~1000+ lines) managing all views and state. View routing is handled via an `AppView` string union (`'main' | 'shopping' | 'import-url' | 'profile' | 'ingredient-preview'`). State includes lists, activeListId, user profile, dark mode, and processing flags. Firebase sync is debounced 2000ms via `updateDoc()`.

**AI Service (`services/geminiService.ts`)** — All Gemini API calls live here:
- `smartMergeItems()` — parses natural language or recipe text into `ExtractedItem[]` with structured JSON output
- `extractFromUrl()` — recipe extraction using Google Search grounding tool
- `extractFromImage()` — multimodal base64 image-to-ingredients
- `categorizeItems()` — assigns items to Swedish store aisles (`Aisle` enum)
- Voice input uses Gemini 2.5 Flash Native Audio via the Live API with function calling; audio is captured as PCM via `ScriptProcessor` and streamed in real time

**Backend (`firebase.ts`)** — Firebase Firestore + Google Auth. User data stored at `users/{userId}`. Lazy getters (`getDb()`, `getAuthService()`) avoid initialization errors. Offline fallback uses a synthetic `SH-OFFLINE` user ID with localStorage.

## Key Types (`types.ts`)

- `GroceryItem`: `{ id, name, quantity?, note?, aisle, checked }`
- `GroceryList`: `{ id, name, icon, items[] }`
- `UserProfile`: `{ name, syncCode, email?, photoURL?, isGoogleAccount? }`
- `Aisle` enum: Swedish store section names (`'Frukt & Grönt'`, `'Mejeri'`, etc.)
- `ExtractedItem`: AI output shape before being merged into `GroceryItem`

## Gemini API Usage Pattern

Structured responses use `responseMimeType: 'application/json'` with a `responseSchema`. The Live API session is held in a `useRef` and managed via `startLiveMode()` / `stopLiveMode()` in `App.tsx`. Function calling in Live API triggers `add_items_to_list`, which calls back into `addExtractedItems()` in the component.

## Notes

- Tailwind CSS is loaded via CDN in `index.html` with a custom config (primary green `#13ec13`). There is no PostCSS/Tailwind installed as a dev dependency.
- Firebase public config is hardcoded in `firebase.ts` — this is intentional for frontend apps.
- `@/` path alias resolves to the project root.
