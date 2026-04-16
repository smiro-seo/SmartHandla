export interface GroceryItem {
  id: string;
  name: string;
  quantity?: string;
  note?: string;
  aisle: string;
  checked: boolean;
}

export interface Recipe {
  id: string;
  name: string;
  sourceUrl?: string;
}

export interface GroceryList {
  id: string;
  name: string;
  icon: string;
  items: GroceryItem[];
  recipes?: Recipe[];
}

export interface UserProfile {
  name: string;
  syncCode: string;
  email?: string;
  photoURL?: string;
  isGoogleAccount?: boolean;
}

export type AppView = 'main' | 'import-url' | 'profile' | 'ingredient-preview';

export enum Aisle {
  PRODUCE = 'Frukt & Grönt',
  BAKERY = 'Bageri',
  DAIRY = 'Mejeri',
  MEAT = 'Kött & Chark',
  FROZEN = 'Fryst',
  PANTRY = 'Skafferi',
  HOUSEHOLD = 'Hem & Hushåll',
  OTHER = 'Övrigt'
}

export type ExtractedItem = {
  name: string;
  quantity?: string;
  aisle: string;
  note?: string;
  // When set by the AI, this is the exact name of an existing list item to merge into
  // instead of adding a new line. quantity should be the merged total.
  mergeWith?: string;
};

/**
 * Interface representing a grounding source from Google Search grounding metadata.
 */
export interface GroundingSource {
  web?: {
    uri: string;
    title: string;
  };
}