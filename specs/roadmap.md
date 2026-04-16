# SmartHandla — Project Roadmap

Generated: 2026-04-16  
Branch: `dev`

---

## Completed

Everything below is live and working in production.

### Auth & Sync
- [x] Google Sign-In via `signInWithRedirect` (iOS PWA compatible)
- [x] Dynamic `authDomain` — Cloudflare `/__/auth/*` proxy keeps OAuth on one origin
- [x] Firestore real-time sync (`onSnapshot`) with 2 s debounced writes
- [x] Offline fallback — `SH-OFFLINE` synthetic user ID stored in `localStorage`
- [x] Auth splash screen while Firebase initialises (prevents flash of login screen)

### Core List Features
- [x] Multiple grocery lists with sidebar navigation
- [x] Aisle grouping with user-defined sort order (persisted to Firestore)
- [x] Check/uncheck items (toggleItem)
- [x] Delete items
- [x] Completed items section (collapsible)
- [x] Shopping mode — full-screen, touch-optimised in-store view

### AI / Input
- [x] Smart text add — single items, multi-item strings, dish names expanded to ingredients
- [x] Recipe URL extraction via Google Search grounding (`extractFromUrl`)
- [x] Image / camera scanning (`extractFromImage`, multimodal Gemini)
- [x] Image source picker bottom sheet (camera vs. gallery)
- [x] Voice input — Gemini 2.5 Flash Native Audio Live API with real-time PCM streaming and `add_items_to_list` function calling
- [x] Gemini API key proxied server-side (Cloudflare Pages Function — key never in browser)

### Smart Merging
- [x] AI `mergeWith` hint — AI flags semantic duplicates by exact existing name
- [x] Client-side word-containment fallback (e.g. "lök" ↔ "Gul lök")
- [x] Quantity arithmetic — same-unit values summed ("2 dl" + "1 dl" → "3 dl")
- [x] Recipe note badge on items (`Utensils` icon + dish name)
- [x] Metric unit enforcement in all AI calls (imperial → metric conversion)

### UX / PWA
- [x] Dark / light mode with `localStorage` persistence and OS preference detection
- [x] Service Worker with navigate fallback (excluding `/__/auth/*`)
- [x] Tailwind CDN with custom primary green `#13ec13` config
- [x] Processing state labels ("Hämtar recept...", "Analyserar bild...")

---

## In Progress

Based on recent commits and active dev context.

- [ ] **Auth redirect robustness** — `getRedirectResult` error handling; iOS PWA auth chain confirmed working but edge cases still being validated
- [ ] **Item merging quality** — AI + client-side hybrid merge (word-containment) is stable; monitoring false positives/negatives in real use

---

## Remaining — Final Polish

These are the gaps between the current state and a fully shipped, polished product.

### High Priority

- [ ] **List management** — Users cannot create, rename, or delete lists. Only the two hardcoded initial lists (`l1`, `l2`) exist. Need: "New list" button, rename in sidebar, delete with confirmation.
- [ ] **Item editing** — No way to edit an item's name, quantity, or aisle after it's been added. Need: tap-to-edit inline or edit sheet.
- [ ] **Error feedback** — All AI and sync failures are silent (`console.error` only). Need: a toast/snackbar so the user knows when something went wrong.

### Medium Priority

- [ ] **Profile view** — `'profile'` exists in `AppView` type but is never rendered. The sidebar shows user info inline; a dedicated profile screen (edit name, sign out, sync code) would complete the UX.
- [ ] **Ingredient preview view** — `'ingredient-preview'` is in `AppView` but unimplemented. Intended use: show AI-extracted items before committing them to the list, so the user can deselect ingredients they don't need.
- [ ] **`import-url` view unreachable** — The view exists and works, but no button in the main UI links to it. URL import currently only works by pasting directly into the main input. Either add an entry point or remove the dead view.
- [ ] **Aisle type consistency** — `Aisle` enum in `types.ts` is never used; the app uses raw string literals from `VALID_AISLES`. Either remove the enum or migrate everything to use it.

### Low Priority / Nice-to-Have

- [ ] **Share / collaborate** — `syncCode` is stored in `UserProfile` but never exposed for sharing. Could allow two users to share a list by syncing to the same Firestore document.
- [ ] **Voice UX** — Live mode closes automatically after one turn (`setTimeout(stopLiveMode, 1500)`). Consider a "keep listening" loop or a manual stop button for longer shopping sessions.
- [ ] **Shopping mode item notes** — The shopping mode card (`App.tsx:888`) shows `item.quantity` but not `item.note` (recipe badge). Minor parity gap with the main list view.
- [ ] **PWA install prompt** — No `beforeinstallprompt` handling. A subtle "Add to Home Screen" nudge would help discovery.
- [ ] **Clear completed items** — There is no "clear all checked" bulk action. Users must delete completed items one by one.
