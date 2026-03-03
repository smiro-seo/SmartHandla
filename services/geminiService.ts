import { GoogleGenAI, Type, FunctionDeclaration, GenerateContentResponse } from "@google/genai";
import { GroceryItem, ExtractedItem, GroundingSource } from "../types";

// Service för att hantera AI-logik
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
            name: { type: Type.STRING, description: 'Varan som ska köpas (t.ex. "mjölk")' },
            quantity: { type: Type.STRING, description: 'Mängd eller antal (t.ex. "2 liter" eller "3 st")' },
            aisle: { type: Type.STRING, description: 'Butiksavdelning (t.ex. "Mejeri", "Frukt & Grönt", "Skafferi")' },
            note: { type: Type.STRING, description: 'En notering eller tagg, t.ex. namnet på en maträtt varan tillhör.' }
          },
          required: ['name', 'aisle']
        }
      }
    },
    required: ['items'],
  },
};

// Fix: Always create a new GoogleGenAI instance right before making an API call and use .text property getter.
export const smartMergeItems = async (existingItems: GroceryItem[], newInput: string): Promise<{ items: ExtractedItem[], isComplex: boolean }> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [{ text: `Nuvarande lista: ${JSON.stringify(existingItems.map(i => ({ name: i.name, quantity: i.quantity })))}\nAnvändaren skriver: "${newInput}"` }]
      },
      config: {
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
                  note: { type: Type.STRING }
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
        systemInstruction: `Du är en expert på inköp och matlagning. 
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
        
        Regler:
        - Svara på svenska.
        - Kategorisera varorna i logiska butiksgångar.
        - Var specifik med mängder.`
      },
    });
    // Fix: Access .text as a property, not a method.
    const text = response.text || '{"items": [], "isComplex": false}';
    return JSON.parse(text) as { items: ExtractedItem[], isComplex: boolean };
  } catch (error) {
    console.error("Smart merge error:", error);
    return { items: [], isComplex: false };
  }
};

// Fix: Always create a new GoogleGenAI instance right before making an API call and correctly extract grounding sources.
export const extractFromUrl = async (url: string): Promise<{ items: ExtractedItem[], sources: GroundingSource[] }> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: { parts: [{ text: `Extrahera alla ingredienser från detta recept som en inköpslista på svenska: ${url}` }] },
      config: {
        tools: [{ googleSearch: {} }],
        systemInstruction: "Hitta receptets ingredienser. Sätt receptets namn som 'note' på alla varor. Returnera en lista på svenska sorterad efter butiksgång i ett tydligt JSON-format."
      },
    });
    
    // Fix: Access .text as a property and extract groundingMetadata chunks.
    const text = response.text || "[]";
    const sources = (response.candidates?.[0]?.groundingMetadata?.groundingChunks as GroundingSource[]) || [];
    
    let items: ExtractedItem[] = [];
    try {
      // Safely clean and parse JSON that might be wrapped in markdown code blocks.
      const cleanedText = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleanedText);
      items = Array.isArray(parsed) ? (parsed as ExtractedItem[]) : (parsed.items || []);
    } catch (e) {
      console.warn("Failed to parse JSON from search result, returning empty items", e);
    }
    
    return { items, sources };
  } catch (error) {
    console.error("URL extraction error:", error);
    return { items: [], sources: [] };
  }
};

// Fix: Always create a new GoogleGenAI instance right before making an API call and follow strict multimodal structure.
export const extractFromImage = async (base64: string): Promise<ExtractedItem[]> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: base64.split(",")[1] } },
          { text: "Identifiera alla ingredienser och varor i den här bilden och skapa en inköpslista på svenska." }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              quantity: { type: Type.STRING },
              aisle: { type: Type.STRING },
              note: { type: Type.STRING }
            },
            required: ["name", "aisle"]
          }
        }
      },
    });
    // Fix: Access .text as a property.
    const text = response.text || "[]";
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as ExtractedItem[]) : [];
  } catch (error) {
    console.error("Image extraction error:", error);
    return [];
  }
};

// Fix: Always create a new GoogleGenAI instance right before making an API call and use property getters for text.
export const categorizeItems = async (items: GroceryItem[]): Promise<GroceryItem[]> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: { parts: [{ text: `Sortera dessa varor i logiska butiksgångar för en matvarubutik: ${items.map(i => i.name).join(", ")}` }] },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              aisle: { type: Type.STRING }
            },
            required: ["name", "aisle"]
          }
        }
      },
    });
    // Fix: Access .text as a property.
    const text = response.text || "[]";
    const categories = JSON.parse(text) as { name: string, aisle: string }[];
    return items.map(item => {
      const cat = categories.find((c) => c.name.toLowerCase() === item.name.toLowerCase());
      return cat ? { ...item, aisle: cat.aisle } : item;
    });
  } catch (error) {
    console.error("Categorization error:", error);
    return items;
  }
};
