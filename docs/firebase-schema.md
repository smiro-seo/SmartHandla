# Firestore Schema Reference

Last updated: 2026-04-16

This document describes every field written to or read from Firestore.
All writes go through two call sites in `App.tsx`; this file is the
authoritative reference for anyone adding fields or migrating data.

---

## Collection: `users`

Single collection. One document per authenticated user.

```
users/
  {userId}/          ← Firebase UID (Google auth) or "SH-OFFLINE" (never synced)
    name
    lists[]
    aisleOrder[]
```

### Document ID

| Value | When used |
|-------|-----------|
| Firebase `user.uid` | User is signed in with Google |
| `SH-{random9}` | Guest / offline fallback — document is **never written** for this ID |

The ID is stored locally in `localStorage` as `smarthandla_user_id` for guest
sessions and overwritten with the Firebase UID on Google sign-in.

---

## Document: `users/{userId}`

### Top-level fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Display name. Set from `user.displayName` (Google) or `userProfile.name` (guest). |
| `lists` | `GroceryList[]` | All the user's grocery lists. See below. |
| `aisleOrder` | `string[]` | User-defined sort order for store aisles. Array of aisle name strings drawn from `VALID_AISLES`. |

### Write sites in `App.tsx`

**Create** (line ~197) — document does not yet exist:
```ts
setDoc(userDocRef, {
  name: userProfile.name,
  lists: INITIAL_LISTS,
  aisleOrder: [...VALID_AISLES],
})
```

**Update** (line ~210) — debounced 2 000 ms after any change to `lists`, `aisleOrder`, or `userProfile.name`:
```ts
updateDoc(doc(db, 'users', userProfile.syncCode), {
  lists,
  name: userProfile.name,
  aisleOrder,
})
```

No partial field updates are used — both `lists` and `aisleOrder` are always
written together as full arrays.

---

## Nested type: `GroceryList`

Stored inline inside the `lists` array (not a sub-collection).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Client-generated ID (`Math.random().toString(36).substr(2,9).toUpperCase()`). |
| `name` | `string` | yes | Human-readable list name (e.g. `"Veckohandling"`). |
| `icon` | `string` | yes | Icon slug (e.g. `"shopping_basket"`, `"calendar"`). Not rendered as an image — reserved for future UI use. |
| `items` | `GroceryItem[]` | yes | All items on this list. |

---

## Nested type: `GroceryItem`

Stored inline inside `GroceryList.items`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Same generator as list ID. |
| `name` | `string` | yes | Item name in Swedish, capitalised (first char uppercased at insert time). |
| `quantity` | `string` | no | Human-readable amount in metric units, e.g. `"2 dl"`, `"500 g"`, `"3 st"`. |
| `note` | `string` | no | Free-form tag. Populated by AI with the source recipe name (e.g. `"Lasagne"`). Displayed with a `Utensils` icon in the list view. |
| `aisle` | `string` | yes | Exactly one value from `VALID_AISLES`. Defaults to `"Övrigt"` if AI returns an unknown value. |
| `checked` | `boolean` | yes | `true` = item has been ticked off. Checked items are hidden from the active list and shown in the collapsed "Markerade Varor" section. |

---

## `aisleOrder` array

An ordered array of aisle name strings. Controls how aisle sections are sorted
in the list view and in the Shopping mode view.

- Default value: `[...VALID_AISLES]` — the canonical order defined in
  `services/geminiService.ts`.
- The user can reorder aisles via the sidebar editor (move up/down).
- Aisle names not present in `aisleOrder` are sorted to the end (index `999`).

**Current canonical order (from `VALID_AISLES`):**
```
Frukt & Grönt
Bageri
Mejeri
Kött & Chark
Skafferi
Fryst
Hem & Hushåll
Övrigt
```

---

## Full example document

```json
{
  "name": "Robin",
  "aisleOrder": [
    "Frukt & Grönt",
    "Mejeri",
    "Kött & Chark",
    "Bageri",
    "Skafferi",
    "Fryst",
    "Hem & Hushåll",
    "Övrigt"
  ],
  "lists": [
    {
      "id": "l1",
      "name": "Min Handlingslista",
      "icon": "shopping_basket",
      "items": [
        {
          "id": "AB3F92XKL",
          "name": "Mjölk",
          "quantity": "1 l",
          "note": null,
          "aisle": "Mejeri",
          "checked": false
        },
        {
          "id": "C7D1E4QWZ",
          "name": "Lök",
          "quantity": "2 st",
          "note": "Lasagne",
          "aisle": "Frukt & Grönt",
          "checked": true
        }
      ]
    },
    {
      "id": "l2",
      "name": "Veckohandling",
      "icon": "calendar",
      "items": []
    }
  ]
}
```

---

## Migration notes

- **Adding a new top-level field**: `updateDoc` uses merge-by-field — existing
  documents will not get the new field until the next write. Add a one-time
  migration or guard with `?? defaultValue` when reading.
- **Adding a field to `GroceryItem`**: Items are written as a full array
  replacement. Old items in Firestore will be overwritten on next sync, so new
  optional fields should have a safe default (`undefined` or a fallback in the
  read path).
- **Renaming an aisle in `VALID_AISLES`**: Existing items store the old string.
  A migration must rewrite `aisle` on all affected items across all user
  documents, or the renamed aisle will sort to position `999`.
- **Sub-collections vs. arrays**: Items and lists are stored as nested arrays,
  not sub-collections. This keeps reads cheap (one `onSnapshot` per user) but
  means there is no per-item write granularity and document size grows with
  list length. Firestore document limit is 1 MB — unlikely to be hit in
  practice for a grocery list app.
