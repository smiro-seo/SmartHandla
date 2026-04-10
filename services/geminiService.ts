import { GoogleGenAI, Type, FunctionDeclaration, GenerateContentResponse } from "@google/genai";
import { ExtractedItem, GroceryItem, GroundingSource } from "../types";

// The complete list of valid Swedish store aisles used throughout the app.
// All AI calls must use exactly these values so items are grouped correctly.
export const VALID_AISLES = [
  'Frukt & Grönt',
  'Bageri',
  'Mejeri',
  'Kött & Chark',
  'Skafferi',
  'Fryst',
  'Hem & Hushåll',
  'Övrigt',
] as const;

const AISLE_INSTRUCTION = `Välj ALLTID avdelning från exakt denna lista (inget annat är tillåtet): ${VALID_AISLES.join(', ')}. Standardvärde: "Övrigt".`;

const METRIC_INSTRUCTION = `Använd ALLTID metriska måttenheter (g, kg, ml, dl, l, msk, tsk, st, krm). Konvertera imperial till metriskt och avrunda till jämna tal (t.ex. 5,5 oz → 2 dl, 1 cup → 2,5 dl, 1 lb → 450 g).`;

// Returns a system instruction block for AI-assisted merging against an existing list.
// The AI sets mergeWith = exact existing name when it recognises a semantic match,
// and returns the TOTAL quantity (existing + new) in the quantity field.
const buildMergeContext = (existingItems: Pick<GroceryItem, 'name' | 'quantity'>[]) => {
  if (!existingItems.length) return '';
  const lines = existingItems.map(i => `"${i.name}"${i.quantity ? ' (' + i.quantity + ')' : ''}`).join(', ');
  return `
SAMMANSLAGNING: Följande varor finns redan i listan: ${lines}.
Om en ny vara är samma sak som en befintlig vara (även om namnen skiljer sig lite, t.ex. "lök" ≈ "Gul lök"), sätt mergeWith till det EXAKTA befintliga varunamnet och returnera den TOTALA mängden i quantity (befintlig + ny, i metriska enheter). Om ingen match finns, lämna mergeWith tomt.`;
};

export const addItemsFunctionDeclaration: FunctionDeclaration = {
  name: 'add_items_to_list',
  parameters: {
    type: Type.OBJECT,
    description: 'Lägger till varor i användarens aktiva inköpslista baserat på vad de säger.',
    properties: {
      items: {
        type: Type.ARRAY,
        description: 'En lista med objekt att lägga till.',
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING, description: 'Varan som ska köpas, på svenska (t.ex. "mjölk").' },
            quantity: { type: Type.STRING, description: 'Mängd i metriska enheter (t.ex. "2 dl", "500 g", "3 st"). Konvertera imperial till metriskt.' },
            aisle: {
              type: Type.STRING,
              description: `Butiksavdelning. Måste vara ett av: ${VALID_AISLES.join(', ')}.`,
            },
            note: { type: Type.STRING, description: 'En notering eller tagg, t.ex. namnet på en maträtt varan tillhör.' }
          },
          required: ['name', 'aisle']
        }
      }
    },
    required: ['items'],
  },
};

// Simple structured output — thinking disabled to avoid unnecessary cost.
export const smartMergeItems = async (
  newInput: string,
  existingItems: Pick<GroceryItem, 'name' | 'quantity'>[] = []
): Promise<{ items: ExtractedItem[], isComplex: boolean }> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: {
        parts: [{ text: `Användaren skriver: "${newInput}"` }]
      },
      config: {
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  quantity: { type: Type.STRING },
                  aisle: { type: Type.STRING },
                  note: { type: Type.STRING },
                  mergeWith: { type: Type.STRING, description: 'Exakt namn på befintlig vara att slå ihop med, om match finns.' }
                },
                required: ["name", "aisle"]
              }
            },
            isComplex: {
              type: Type.BOOLEAN,
              description: "Sätt till true om inputen var en maträtt som expanderades eller en lång lista (3+ varor). Sätt till false om det bara var 1-2 enkla varor."
            }
          },
          required: ["items", "isComplex"]
        },
        systemInstruction: `Du är en expert på inköp och matlagning. Svara alltid på svenska.
        Din uppgift är att tolka användarens input och returnera en lista med varor.

        VIKTIGT - MATRÄTTER VS VAROR:
        1. Om användaren skriver en MATRÄTT (t.ex. "Lasagne", "Tacos"):
           - Expandera till ingredienser.
           - Sätt 'note' till namnet på maträtten för VARJE ingrediens (t.ex. "Lasagne").
           - Sätt isComplex: true.
        2. Om användaren skriver en LISTA med flera varor (3 eller fler):
           - Sätt isComplex: true.
        3. Om användaren skriver 1-2 ENKLA VAROR (t.ex. "mjölk", "smör och bröd"):
           - Sätt isComplex: false.

        ${AISLE_INSTRUCTION}
        ${METRIC_INSTRUCTION}
        ${buildMergeContext(existingItems)}
        Var specifik med mängder.`
      },
    });
    const text = response.text || '{"items": [], "isComplex": false}';
    return JSON.parse(text) as { items: ExtractedItem[], isComplex: boolean };
  } catch (error) {
    console.error("Smart merge error:", error);
    return { items: [], isComplex: false };
  }
};

// Complex task: web search + long-context extraction — thinking left at default.
export const extractFromUrl = async (
  url: string,
  existingItems: Pick<GroceryItem, 'name' | 'quantity'>[] = []
): Promise<{ items: ExtractedItem[], sources: GroundingSource[] }> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  try {
    const mergeContext = existingItems.length
      ? ` Befintliga varor i listan: ${existingItems.map(i => `"${i.name}"${i.quantity ? ' (' + i.quantity + ')' : ''}`).join(', ')}. Om en ingrediens matchar en befintlig vara, lägg till fältet "mergeWith" med det exakta befintliga varunamnet och returnera den totala mängden i "quantity".`
      : '';
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: { parts: [{ text: `Extrahera alla ingredienser från detta recept och returnera ENBART ett JSON-array (inga andra ord, inget markdown) med denna struktur: [{"name":"...","quantity":"...","aisle":"...","note":"receptnamnet","mergeWith":"...eller utelämna om ny vara"}]. Recept-URL: ${url}` }] },
      config: {
        tools: [{ googleSearch: {} }],
        systemInstruction: `Du är en matvaruexpert. Svara alltid på svenska. Hitta receptets alla ingredienser. Sätt receptets namn som 'note' på varje vara. ${AISLE_INSTRUCTION} ${METRIC_INSTRUCTION}${mergeContext} Returnera ENBART ett rent JSON-array, inget annat.`
      },
    });

    const text = response.text || "[]";
    const sources = (response.candidates?.[0]?.groundingMetadata?.groundingChunks as GroundingSource[]) || [];

    let items: ExtractedItem[] = [];
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        items = Array.isArray(parsed) ? (parsed as ExtractedItem[]) : (parsed.items || []);
      }
    } catch (e) {
      console.warn("Failed to parse JSON from search result, returning empty items", e);
    }

    // Clamp any aisle values that didn't match the predefined list.
    items = items.map(item => ({
      ...item,
      aisle: (VALID_AISLES as readonly string[]).includes(item.aisle) ? item.aisle : 'Övrigt',
    }));

    return { items, sources };
  } catch (error) {
    console.error("URL extraction error:", error);
    return { items: [], sources: [] };
  }
};

// Vision task — straightforward extraction, thinking disabled to reduce cost.
export const extractFromImage = async (
  base64: string,
  existingItems: Pick<GroceryItem, 'name' | 'quantity'>[] = []
): Promise<ExtractedItem[]> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const mimeType = base64.startsWith('data:') ? base64.split(';')[0].split(':')[1] : 'image/jpeg';
  const imageData = base64.includes(',') ? base64.split(',')[1] : base64;
  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: {
        parts: [
          { inlineData: { mimeType: mimeType as any, data: imageData } },
          { text: "Identifiera alla ingredienser och varor i den här bilden och skapa en inköpslista på svenska." }
        ]
      },
      config: {
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              quantity: { type: Type.STRING },
              aisle: { type: Type.STRING },
              note: { type: Type.STRING },
              mergeWith: { type: Type.STRING, description: 'Exakt namn på befintlig vara att slå ihop med, om match finns.' }
            },
            required: ["name", "aisle"]
          }
        },
        systemInstruction: `Du är en matvaruexpert. Svara alltid på svenska. ${AISLE_INSTRUCTION} ${METRIC_INSTRUCTION} ${buildMergeContext(existingItems)}`
      },
    });
    const text = response.text || "[]";
    const parsed = JSON.parse(text);
    const items: ExtractedItem[] = Array.isArray(parsed) ? parsed : [];
    // Clamp any aisle values that didn't match the predefined list.
    return items.map(item => ({
      ...item,
      aisle: (VALID_AISLES as readonly string[]).includes(item.aisle) ? item.aisle : 'Övrigt',
    }));
  } catch (error) {
    console.error("Image extraction error:", error);
    return [];
  }
};
