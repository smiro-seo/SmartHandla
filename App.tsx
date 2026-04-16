import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Menu,
  Mic,
  Camera,
  Check,
  X,
  Loader2,
  ChevronDown, 
  ChevronUp, 
  SendHorizontal, 
  Sun, 
  Moon, 
  Trash2, 
  ShoppingBasket, 
  Utensils, 
  Cloud, 
  CloudUpload, 
  User, 
  LogOut,
  Settings2,
  ImageIcon,
  ExternalLink,
  ChefHat,
} from 'lucide-react';
import { GoogleGenAI, Modality, Blob, LiveServerMessage } from "@google/genai";
import { onAuthStateChanged, signInWithRedirect, signInWithPopup, getRedirectResult, signOut, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { doc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { getDb, getAuthService, googleProvider } from './firebase';
import { GroceryItem, GroceryList, Recipe, AppView, ExtractedItem, GroundingSource, UserProfile } from './types';
import {
  extractFromUrl,
  smartMergeItems,
  extractFromImage,
  addItemsFunctionDeclaration,
  VALID_AISLES
} from './services/geminiService';

// --- INITIALDATA ---
const INITIAL_LISTS: GroceryList[] = [
  { id: 'l1', name: 'Min Handlingslista', icon: 'shopping_basket', items: [] },
  { id: 'l2', name: 'Veckohandling', icon: 'calendar', items: [] },
];


// --- HJÄLPFUNKTIONER ---
const isDev = () =>
  typeof window !== 'undefined' &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname);

const generateId = () => Math.random().toString(36).substr(2, 9).toUpperCase();

const getStoredUserId = () => {
  if (typeof window === 'undefined' || !window.localStorage) return 'SH-OFFLINE';
  let id = localStorage.getItem('smarthandla_user_id');
  if (!id) {
    id = 'SH-' + generateId();
    localStorage.setItem('smarthandla_user_id', id);
  }
  return id;
};

// --- LJUD-HJÄLPARE ---
function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
  }
  return buffer;
}

function createBlob(data: Float32Array): Blob {
  const int16 = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) int16[i] = data[i] * 32768;
  return { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
}

// --- HUVUDKOMPONENT ---

export default function App() {
  const [view, setView] = useState<AppView>('main');
  const [lists, setLists] = useState<GroceryList[]>(INITIAL_LISTS);
  const [activeListId, setActiveListId] = useState('l1');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isFirebaseReady, setIsFirebaseReady] = useState(false);
  const [isCompletedExpanded, setIsCompletedExpanded] = useState(false);
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [voiceTranscription, setVoiceTranscription] = useState('');
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window === 'undefined') return false;
    const saved = localStorage.getItem('theme');
    return saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches);
  });
  
  const [userProfile, setUserProfile] = useState<UserProfile>(() => isDev()
    ? { name: 'Dev', syncCode: 'SH-OFFLINE', isGoogleAccount: true }
    : {
        name: (typeof localStorage !== 'undefined' && localStorage.getItem('smarthandla_user_name')) || 'Gäst',
        syncCode: getStoredUserId(),
        isGoogleAccount: false,
      }
  );

  const liveSessionRef = useRef<any>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const activeListIdRef = useRef(activeListId);
  const listsRef = useRef<GroceryList[]>(INITIAL_LISTS);
  const isInitialLoad = useRef(true);
  const audioSourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const nextStartTimeRef = useRef(0);
  const currentInputTranscriptionRef = useRef('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [processingLabel, setProcessingLabel] = useState('Bearbetar...');
  const [aisleOrder, setAisleOrder] = useState<string[]>([...VALID_AISLES]);
  const [isAisleEditorOpen, setIsAisleEditorOpen] = useState(false);
  const [isImagePickerOpen, setIsImagePickerOpen] = useState(false);
  const [isDinnersOpen, setIsDinnersOpen] = useState(false);

  const activeList = useMemo(() => lists.find(l => l.id === activeListId) || lists[0], [lists, activeListId]);
  const activeRecipes = useMemo(() => activeList.recipes || [], [activeList.recipes]);

  const itemsByAisle = useMemo(() => {
    const grouped: Record<string, GroceryItem[]> = {};
    activeList.items.filter(i => !i.checked).forEach(item => {
      const aisle = item.aisle || 'Övrigt';
      if (!grouped[aisle]) grouped[aisle] = [];
      grouped[aisle].push(item);
    });
    return grouped;
  }, [activeList.items]);

  const sortedAisleEntries = useMemo(() => {
    return Object.entries(itemsByAisle).sort(([a], [b]) => {
      const ai = aisleOrder.indexOf(a);
      const bi = aisleOrder.indexOf(b);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
  }, [itemsByAisle, aisleOrder]);

  const completedItems = useMemo(() =>
    activeList.items.filter(i => i.checked).sort((a, b) => (b.checkedAt ?? 0) - (a.checkedAt ?? 0)),
  [activeList.items]);

  useEffect(() => {
    const timer = setTimeout(() => setIsFirebaseReady(true), 800);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!isFirebaseReady || isDev()) return;
    try {
      const auth = getAuthService();
      // Process the result from a signInWithRedirect call if returning from Google.
      getRedirectResult(auth).catch(e => console.error("Redirect auth error:", e));
      return onAuthStateChanged(auth, (user: any) => {
        if (user) {
          setUserProfile({ 
            name: user.displayName || 'Användare', 
            syncCode: user.uid, 
            email: user.email, 
            photoURL: user.photoURL, 
            isGoogleAccount: true 
          });
        } else {
          setUserProfile(prev => ({ 
            ...prev, 
            isGoogleAccount: false, 
            photoURL: undefined 
          }));
        }
      });
    } catch (e) { console.warn("Auth initialization skipped:", e); }
  }, [isFirebaseReady]);

  useEffect(() => {
    if (!isFirebaseReady || !userProfile.syncCode || userProfile.syncCode === 'SH-OFFLINE') return;
    try {
      const db = getDb();
      const userDocRef = doc(db, 'users', userProfile.syncCode);
      return onSnapshot(userDocRef, (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data.lists) setLists(data.lists);
          if (data.aisleOrder) setAisleOrder(data.aisleOrder);
        } else {
          setDoc(userDocRef, { name: userProfile.name, lists: INITIAL_LISTS, aisleOrder: [...VALID_AISLES] });
        }
        isInitialLoad.current = false;
      });
    } catch (e) { console.warn("Firestore sync skipped:", e); }
  }, [isFirebaseReady, userProfile.syncCode]);

  useEffect(() => {
    if (isInitialLoad.current || !isFirebaseReady || userProfile.syncCode === 'SH-OFFLINE') return;
    const update = async () => {
      setIsSyncing(true);
      try {
        const db = getDb();
        // JSON round-trip strips all undefined values (Firestore rejects them).
        const sanitizedLists = JSON.parse(JSON.stringify(
          (lists as GroceryList[]).map(l => ({ ...l, recipes: l.recipes ?? [] }))
        ));
        await updateDoc(doc(db, 'users', userProfile.syncCode), { lists: sanitizedLists, name: userProfile.name, aisleOrder });
      } catch (e) { console.warn("Sync failed:", e); }
      finally { setIsSyncing(false); }
    };
    const t = setTimeout(update, 2000);
    return () => clearTimeout(t);
  }, [lists, aisleOrder, userProfile.name, isFirebaseReady]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  useEffect(() => { activeListIdRef.current = activeListId; }, [activeListId]);
  useEffect(() => { listsRef.current = lists as GroceryList[]; }, [lists]);

  // --- FUNKTIONER ---

  // Normalise a name for comparison: lowercase, trim, collapse whitespace.
  const normName = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');

  // Returns true when every word in the shorter name appears as a whole word
  // in the longer name. E.g. "lök" matches "Gul lök"; "mjölk" does NOT match "lök".
  const namesMatch = (a: string, b: string): boolean => {
    const na = normName(a);
    const nb = normName(b);
    if (na === nb) return true;
    const wa = na.split(' ').filter(w => w.length > 1);
    const wb = nb.split(' ').filter(w => w.length > 1);
    if (!wa.length || !wb.length) return false;
    const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
    return shorter.every(w => longer.includes(w));
  };

  // Adds two quantity strings that share the same unit. "2 dl" + "1 dl" → "3 dl".
  // Returns the existing quantity unchanged when units differ or parsing fails.
  const tryMergeQuantity = (existing: string | undefined, incoming: string | undefined): string | undefined => {
    if (!incoming) return existing;
    if (!existing) return incoming;
    const parse = (q: string) => {
      const m = q.trim().match(/^([\d.,]+)\s*(.*)$/);
      if (!m) return null;
      return { value: parseFloat(m[1].replace(',', '.')), unit: m[2].trim().toLowerCase() };
    };
    const a = parse(existing);
    const b = parse(incoming);
    if (!a || !b || a.unit !== b.unit) return existing;
    const sum = Math.round((a.value + b.value) * 10) / 10;
    const display = sum % 1 === 0 ? sum.toFixed(0) : sum.toFixed(1);
    return a.unit ? `${display} ${a.unit}` : display;
  };

  const addExtractedItems = (newItems: ExtractedItem[]) => {
    setLists(prev => (prev as GroceryList[]).map(list => {
      if (list.id !== activeListIdRef.current) return list;
      const updated = [...list.items];
      const toAdd: GroceryItem[] = [];
      for (const newItem of newItems) {
        // 1. AI hint: exact name match on the name the AI flagged
        const aiIdx = newItem.mergeWith
          ? updated.findIndex(e => e.name === newItem.mergeWith)
          : -1;
        // 2. Client-side: word-containment match (handles "lök" ↔ "Gul lök")
        const clientIdx = aiIdx === -1
          ? updated.findIndex(e => namesMatch(e.name, newItem.name))
          : -1;
        const matchIdx = aiIdx !== -1 ? aiIdx : clientIdx;

        if (matchIdx !== -1) {
          updated[matchIdx] = {
            ...updated[matchIdx],
            quantity: tryMergeQuantity(updated[matchIdx].quantity, newItem.quantity),
            // Carry over the recipe note so the badge keeps showing
            note: newItem.note || updated[matchIdx].note,
          };
        } else {
          toAdd.push({
            ...newItem,
            name: newItem.name ? newItem.name.charAt(0).toUpperCase() + newItem.name.slice(1) : newItem.name,
            id: generateId(),
            checked: false,
            aisle: newItem.aisle || 'Övrigt',
          });
        }
      }
      return { ...list, items: [...updated, ...toAdd] };
    }));
  };

  const isUrl = (value: string) => /^https?:\/\/.+/i.test(value.trim());

  const handleSmartAdd = async () => {
    if (!inputValue.trim()) return;
    const text = inputValue.trim();
    setInputValue('');
    setIsProcessing(true);

    // Read from ref so we always have the latest list state even if this
    // closure was created before the most recent item was added.
    const currentItems = listsRef.current.find(l => l.id === activeListIdRef.current)?.items ?? [];

    if (isUrl(text)) {
      setProcessingLabel('Hämtar recept...');
      try {
        const res = await extractFromUrl(text, currentItems);
        if (res.items.length > 0) {
          addExtractedItems(res.items);
          const recipeName = res.items[0]?.note || new URL(text).hostname;
          addRecipe({ id: generateId(), name: recipeName, sourceUrl: text });
        }
      } catch (e) { console.error("URL extraction error:", e); }
    } else {
      setProcessingLabel('Bearbetar...');
      try {
        const res = await smartMergeItems(text, currentItems);
        addExtractedItems(res.items);
        if (res.isComplex && res.items.length > 0) {
          const recipeName = res.items[0]?.note || text;
          addRecipe({ id: generateId(), name: recipeName });
        }
      } catch (e) { console.error("Smart add error:", e); }
    }

    setIsProcessing(false);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so the same file can be picked again later
    e.target.value = '';
    if (!file) return;

    setIsProcessing(true);
    setProcessingLabel('Analyserar bild...');
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const currentItems = listsRef.current.find(l => l.id === activeListIdRef.current)?.items ?? [];
      const items = await extractFromImage(base64, currentItems);
      if (items.length > 0) {
        addExtractedItems(items);
        const recipeName = items[0]?.note || 'Foto-recept';
        addRecipe({ id: generateId(), name: recipeName });
      }
    } catch (e) {
      console.error("Image processing error:", e);
    } finally {
      setIsProcessing(false);
    }
  };

  const stopLiveMode = () => {
    setIsLiveMode(false);
    if (liveSessionRef.current) {
      try { liveSessionRef.current.close(); } catch(e) {}
      liveSessionRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    // Stop microphone tracks so the browser removes the recording indicator.
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    // Close audio contexts to free OS resources.
    if (inputAudioCtxRef.current) {
      try { inputAudioCtxRef.current.close(); } catch(e) {}
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      try { outputAudioCtxRef.current.close(); } catch(e) {}
      outputAudioCtxRef.current = null;
    }
    audioSourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  };

  const startLiveMode = async () => {
    if (isLiveMode) { stopLiveMode(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      inputAudioCtxRef.current = inputCtx;
      setIsLiveMode(true);
      setVoiceTranscription('Jag lyssnar...');
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = scriptProcessor;
            scriptProcessor.onaudioprocess = (e) => {
              const pcmBlob = createBlob(e.inputBuffer.getChannelData(0));
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (m: LiveServerMessage) => {
            if (m.serverContent?.inputTranscription) {
              currentInputTranscriptionRef.current += m.serverContent.inputTranscription.text || '';
              setVoiceTranscription(`Du: ${currentInputTranscriptionRef.current}`);
            }
            if (m.toolCall) {
              const fcs = (m.toolCall as any).functionCalls || [];
              for (const fc of fcs) {
                if (fc.name === 'add_items_to_list' && fc.args.items) {
                  addExtractedItems(fc.args.items);
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: [{
                      id: fc.id,
                      name: fc.name,
                      response: { result: "ok" }
                    }]
                  }));
                }
              }
            }
            if (m.serverContent?.turnComplete) { 
              currentInputTranscriptionRef.current = ''; 
              setTimeout(stopLiveMode, 1500); 
            }
          }
        },
        config: {
          responseModalities: [Modality.TEXT],
          tools: [{ functionDeclarations: [addItemsFunctionDeclaration] }],
          systemInstruction: `Du är en svensk inköpsassistent. Lägg till varor när användaren pratar. Svara INTE med text eller ljud — anropa bara add_items_to_list-funktionen. Välj alltid avdelning från: ${VALID_AISLES.join(', ')}. Använd alltid metriska måttenheter (g, kg, dl, ml, st). Konvertera imperial till metriskt och avrunda till jämna tal.`
        }
      });
      liveSessionRef.current = await sessionPromise;
    } catch (e) { setIsLiveMode(false); }
  };

  const handleLogin = async () => {
    try {
      const auth = getAuthService();
      await setPersistence(auth, browserLocalPersistence);
      // iOS PWA: must use redirect — popups open in Safari (different context)
      // so the auth result never lands back in the WebView.
      // Android + Desktop: use popup via Chrome Custom Tab, which correctly
      // returns the result to the originating context without the
      // cross-context redirect problem that breaks Android PWA.
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      if (isIOS) {
        await signInWithRedirect(auth, googleProvider);
      } else {
        await signInWithPopup(auth, googleProvider);
      }
    } catch (e) { console.error("Login error:", e); }
  };

  const handleLogout = async () => {
    try { 
      await signOut(getAuthService()); 
      setUserProfile({ name: 'Gäst', syncCode: getStoredUserId(), isGoogleAccount: false }); 
    } catch (e) { console.error("Logout error:", e); }
  };

  const toggleItem = (itemId: string, checked: boolean) => {
    setLists(prev => (prev as GroceryList[]).map(l =>
      l.id === activeListId ? { ...l, items: l.items.map(i => i.id === itemId ? { ...i, checked, checkedAt: checked ? Date.now() : undefined } : i) } : l
    ));
  };

  const moveAisle = (index: number, direction: -1 | 1) => {
    const next = index + direction;
    if (next < 0 || next >= aisleOrder.length) return;
    const updated = [...aisleOrder];
    [updated[index], updated[next]] = [updated[next], updated[index]];
    setAisleOrder(updated);
  };

  const deleteItem = (itemId: string) => {
    setLists(prev => (prev as GroceryList[]).map(l =>
      l.id === activeListId ? { ...l, items: l.items.filter(i => i.id !== itemId) } : l
    ));
  };

  const addRecipe = (recipe: Recipe) => {
    setLists(prev => (prev as GroceryList[]).map(l => {
      if (l.id !== activeListIdRef.current) return l;
      const existing = l.recipes || [];
      if (existing.some(r => r.name === recipe.name)) return l;
      return { ...l, recipes: [...existing, recipe] };
    }));
  };

  const removeRecipe = (recipeId: string) => {
    setLists(prev => (prev as GroceryList[]).map(l =>
      l.id !== activeListId ? l : { ...l, recipes: (l.recipes || []).filter(r => r.id !== recipeId) }
    ));
  };

  // Show splash while Firebase initialises (avoids flash of login screen for returning users)
  if (!isFirebaseReady) {
    return (
      <div className="min-h-screen bg-background-dark flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <h1 className="text-4xl font-black text-primary italic tracking-tighter">SmartHandla</h1>
          <Loader2 className="animate-spin text-primary" size={28} />
        </div>
      </div>
    );
  }

  // Block access until the user is signed in with Google
  if (!userProfile.isGoogleAccount) {
    return (
      <div className="min-h-screen bg-background-dark flex items-center justify-center p-6">
        <div className="w-full max-w-sm flex flex-col items-center gap-8 text-center">
          <div>
            <h1 className="text-5xl font-black text-primary italic tracking-tighter mb-3">SmartHandla</h1>
            <p className="text-gray-400 font-bold text-sm">Din smarta AI-inköpslista</p>
          </div>
          <div className="w-full p-8 bg-gray-900 rounded-[2rem] border border-gray-800 shadow-2xl space-y-6">
            <div className="space-y-2">
              <p className="font-black text-white text-lg">Välkommen!</p>
              <p className="text-gray-400 text-sm font-bold leading-relaxed">
                Logga in med ditt Google-konto för att använda SmartHandla.
              </p>
            </div>
            <button
              onClick={handleLogin}
              className="w-full py-4 text-sm font-black text-white bg-blue-600 rounded-2xl shadow-xl shadow-blue-600/20 hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-3"
            >
              <div className="bg-white text-blue-600 w-5 h-5 rounded-sm flex items-center justify-center font-black text-[10px]">G</div>
              Logga in med Google
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background-light dark:bg-background-dark font-sans transition-colors duration-300">
      {/* Hidden file inputs — absolute+opacity instead of display:none (Android PWA blocks .click() on display:none) */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileUpload}
        accept="image/*"
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0, overflow: 'hidden' }}
      />
      <input
        type="file"
        ref={cameraInputRef}
        onChange={handleFileUpload}
        accept="image/*"
        capture="environment"
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0, overflow: 'hidden' }}
      />

      {/* Image source picker bottom sheet */}
      {isImagePickerOpen && (
        <div className="fixed inset-0 z-[200] flex items-end" onClick={() => setIsImagePickerOpen(false)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="relative w-full bg-white dark:bg-gray-900 rounded-t-3xl p-6 pb-10 flex flex-col gap-3 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="w-10 h-1 bg-gray-300 dark:bg-gray-600 rounded-full mx-auto mb-2" />
            <button
              onClick={() => { setIsImagePickerOpen(false); setTimeout(() => cameraInputRef.current?.click(), 50); }}
              className="flex items-center gap-4 w-full px-4 py-4 rounded-2xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors font-semibold text-left"
            >
              <Camera size={22} className="text-primary" />
              Ta foto
            </button>
            <button
              onClick={() => { setIsImagePickerOpen(false); setTimeout(() => fileInputRef.current?.click(), 50); }}
              className="flex items-center gap-4 w-full px-4 py-4 rounded-2xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors font-semibold text-left"
            >
              <ImageIcon size={22} className="text-primary" />
              Välj från album
            </button>
          </div>
        </div>
      )}

      {/* Sidomeny (Sidebar) */}
      <div className={`fixed inset-0 z-[100] transition-opacity duration-300 ${isSidebarOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setIsSidebarOpen(false)} />
        <aside className={`absolute inset-y-0 left-0 w-80 bg-white dark:bg-gray-900 shadow-2xl transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <div className="p-6 h-full flex flex-col">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-2xl font-black text-primary italic tracking-tighter">SmartHandla</h2>
              <button onClick={() => setIsSidebarOpen(false)} className="p-2 dark:text-gray-400"><X /></button>
            </div>

            {/* Inloggningsruta i menyn */}
            <div className="mb-8 p-5 bg-gray-50 dark:bg-gray-800/50 rounded-3xl border dark:border-gray-800">
              <div className="flex items-center gap-4 mb-5">
                {userProfile.photoURL ? (
                  <img src={userProfile.photoURL} alt="" className="w-14 h-14 rounded-full border-2 border-primary shadow-sm" />
                ) : (
                  <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center text-primary-dark border-2 border-primary/20">
                    <User size={28} />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="font-bold truncate dark:text-white text-lg">{userProfile.name}</p>
                  <p className="text-[10px] text-gray-500 font-black uppercase tracking-widest">
                    {userProfile.isGoogleAccount ? 'Inloggad via Google' : 'Gästläge (Spara lokalt)'}
                  </p>
                </div>
              </div>
              {userProfile.isGoogleAccount ? (
                <button 
                  onClick={handleLogout} 
                  className="w-full py-3 text-sm font-black text-red-500 bg-red-50 dark:bg-red-900/10 rounded-2xl flex items-center justify-center gap-2 hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors"
                >
                  <LogOut size={16} /> Logga ut
                </button>
              ) : (
                <button 
                  onClick={handleLogin} 
                  className="w-full py-4 text-sm font-black text-white bg-blue-600 rounded-2xl shadow-xl shadow-blue-600/20 hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-3"
                >
                  <div className="bg-white text-blue-600 w-5 h-5 rounded-sm flex items-center justify-center font-black text-[10px]">G</div>
                  Logga in med Google
                </button>
              )}
            </div>

            <nav className="flex-1 space-y-2 overflow-y-auto hide-scrollbar">
              <p className="text-[10px] font-black uppercase text-gray-400 tracking-[0.2em] mb-3 px-2">Dina Inköpslistor</p>
              {(lists as GroceryList[]).map(l => (
                <button 
                  key={l.id} 
                  onClick={() => { setActiveListId(l.id); setIsSidebarOpen(false); }}
                  className={`w-full p-4 rounded-2xl flex items-center gap-4 font-bold transition-all ${activeListId === l.id ? 'bg-primary text-black shadow-lg shadow-primary/20' : 'hover:bg-gray-100 dark:hover:bg-gray-800 dark:text-gray-300'}`}
                >
                  <ShoppingBasket size={22} />
                  <span className="flex-1 text-left">{l.name}</span>
                  <div className={`px-2 py-0.5 rounded-full text-[10px] font-black ${activeListId === l.id ? 'bg-black/10' : 'bg-gray-100 dark:bg-gray-800'}`}>
                    {l.items.filter(i => !i.checked).length}
                  </div>
                </button>
              ))}
            </nav>

            <div className="pt-6 border-t dark:border-gray-800 space-y-3">
              {/* Aisle order editor */}
              <div>
                <button
                  onClick={() => setIsAisleEditorOpen(!isAisleEditorOpen)}
                  className="w-full py-4 rounded-2xl border-2 dark:border-gray-800 flex items-center justify-center gap-3 font-black text-sm dark:text-white hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  <Settings2 size={20} />
                  Sortera avdelningar
                  {isAisleEditorOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                {isAisleEditorOpen && (
                  <div className="mt-2 p-2 bg-gray-50 dark:bg-gray-800/50 rounded-2xl border dark:border-gray-700 space-y-0.5">
                    {aisleOrder.map((aisle, index) => (
                      <div key={aisle} className="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-white dark:hover:bg-gray-700/50 transition-colors">
                        <span className="flex-1 text-sm font-bold dark:text-white truncate">{aisle}</span>
                        <button
                          onClick={() => moveAisle(index, -1)}
                          disabled={index === 0}
                          className="p-1 rounded-lg text-gray-400 hover:text-primary disabled:opacity-20 transition-colors"
                        >
                          <ChevronUp size={15} />
                        </button>
                        <button
                          onClick={() => moveAisle(index, 1)}
                          disabled={index === aisleOrder.length - 1}
                          className="p-1 rounded-lg text-gray-400 hover:text-primary disabled:opacity-20 transition-colors"
                        >
                          <ChevronDown size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={() => setIsDarkMode(!isDarkMode)}
                className="w-full py-4 rounded-2xl border-2 dark:border-gray-800 flex items-center justify-center gap-3 font-black text-sm dark:text-white hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                {isDarkMode ? <Sun size={20} /> : <Moon size={20} />} {isDarkMode ? 'Ljust läge' : 'Mörkt läge'}
              </button>
            </div>
          </div>
        </aside>
      </div>

      {/* Header */}
      <header className="px-6 py-5 bg-white/80 dark:bg-gray-900/80 backdrop-blur-md border-b dark:border-gray-800 sticky top-0 z-50 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={() => setIsSidebarOpen(true)} className="p-2 -ml-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl dark:text-white transition-colors"><Menu /></button>
          <div>
            <h1 className="font-black text-xl dark:text-white leading-tight tracking-tight">{activeList.name}</h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              {isSyncing ? (
                <CloudUpload size={14} className="text-primary animate-pulse" />
              ) : (
                <Cloud size={14} className="text-gray-400" />
              )}
              <span className="text-[10px] font-black uppercase text-gray-400 tracking-widest">
                {isSyncing ? 'Sparar ändringar...' : 'Synkroniserad'}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Huvudinnehåll */}
      <main className="max-w-2xl mx-auto w-full p-6 space-y-8 pb-32">
        {/* Inmatningsfältet */}
        <section className="bg-white dark:bg-gray-900 p-2 rounded-[2rem] shadow-2xl border-2 border-primary/20 dark:border-gray-800 focus-within:border-primary transition-all">
          <div className="flex items-center gap-2">
            <button 
              onClick={startLiveMode} 
              className={`p-4 rounded-full transition-all ${isLiveMode ? 'bg-red-500 text-white animate-pulse' : 'text-primary hover:bg-primary/10'}`}
              title="Prata in varor"
            >
              <Mic size={26} />
            </button>
            <input 
              value={inputValue} 
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSmartAdd()}
              placeholder="Vara, maträtt eller receptlänk..."
              className="flex-1 bg-transparent border-none focus:ring-0 font-bold text-lg dark:text-white placeholder-gray-400 py-4"
            />
            {inputValue.trim() || isProcessing ? (
              <button 
                onClick={handleSmartAdd} 
                disabled={isProcessing}
                className="p-4 bg-primary text-black rounded-full shadow-xl shadow-primary/20 hover:scale-105 active:scale-90 transition-all disabled:opacity-50"
              >
                {isProcessing ? <Loader2 className="animate-spin" /> : <SendHorizontal size={24} />}
              </button>
            ) : (
              <button
                onClick={() => setIsImagePickerOpen(true)}
                className="p-4 text-gray-400 hover:text-primary transition-colors"
                title="Skanna kvitto eller bild"
              >
                <Camera size={26} />
              </button>
            )}
          </div>
          {(isLiveMode || isProcessing) && (
            <div className="px-8 py-3 border-t dark:border-gray-800 text-sm font-black text-primary italic animate-pulse flex items-center gap-2">
              <div className="w-2 h-2 bg-primary rounded-full animate-ping" />
              {isProcessing ? processingLabel : voiceTranscription}
            </div>
          )}
        </section>

        {/* Middagar */}
        {activeRecipes.length > 0 && (
          <div>
            <button
              onClick={() => setIsDinnersOpen(!isDinnersOpen)}
              className="flex items-center gap-2 text-xs font-black uppercase text-gray-400 px-2 mb-3 tracking-widest hover:text-gray-600 transition-colors"
            >
              {isDinnersOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              <ChefHat size={15} />
              Middagar ({activeRecipes.length})
            </button>
            {isDinnersOpen && (
              <div className="bg-white dark:bg-gray-900 rounded-[2rem] overflow-hidden shadow-sm border dark:border-gray-800">
                {activeRecipes.map(recipe => (
                  <div key={recipe.id} className="group flex items-center gap-4 p-5 border-b last:border-0 dark:border-gray-800 hover:bg-gray-50/80 dark:hover:bg-gray-800/40 transition-colors">
                    <ChefHat size={18} className="text-primary shrink-0" />
                    <p className="flex-1 font-bold dark:text-white text-base leading-tight">{recipe.name}</p>
                    {recipe.sourceUrl && (
                      <a
                        href={recipe.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 text-gray-400 hover:text-primary transition-colors rounded-xl hover:bg-primary/10"
                        title="Öppna recept"
                      >
                        <ExternalLink size={17} />
                      </a>
                    )}
                    <button
                      onClick={() => removeRecipe(recipe.id)}
                      className="p-2 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all hover:bg-red-50 dark:hover:bg-red-900/10 rounded-xl"
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Listvisning */}
        <div className="space-y-10">
          {Object.keys(itemsByAisle).length === 0 && completedItems.length === 0 && (
            <div className="py-24 flex flex-col items-center justify-center opacity-20 text-center">
              <ShoppingBasket size={80} className="mb-6" />
              <p className="font-black text-xl dark:text-white tracking-tight">Din lista är tom.<br/>Börja skriva för att lägga till!</p>
            </div>
          )}

          {sortedAisleEntries.map(([aisle, items]) => (
            <div key={aisle} className="space-y-4">
              <h3 className="text-[11px] font-black uppercase text-gray-400 tracking-[0.25em] px-2 flex items-center gap-2">
                <div className="w-1.5 h-1.5 bg-primary rounded-full" />
                {aisle}
              </h3>
              <div className="bg-white dark:bg-gray-900 rounded-[2rem] overflow-hidden shadow-sm border dark:border-gray-800">
                {(items as GroceryItem[]).map(item => (
                  <div 
                    key={item.id} 
                    className="group flex items-center gap-5 p-5 border-b last:border-0 dark:border-gray-800 hover:bg-gray-50/80 dark:hover:bg-gray-800/40 transition-colors"
                  >
                    <button 
                      onClick={() => toggleItem(item.id, true)}
                      className="w-7 h-7 rounded-xl border-2 border-gray-200 dark:border-gray-700 hover:border-primary flex items-center justify-center transition-all active:scale-90"
                    >
                      {item.checked && <Check size={18} className="text-primary stroke-[3]" />}
                    </button>
                    <div className="flex-1" onClick={() => toggleItem(item.id, true)}>
                      <p className="font-bold dark:text-white text-base leading-tight">{item.name}</p>
                      {item.quantity && (
                        <p className="text-[11px] font-black text-primary-dark/70 dark:text-primary uppercase tracking-tighter mt-0.5">
                          {item.quantity}
                        </p>
                      )}
                      {item.note && (
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-tight flex items-center gap-1 mt-1">
                          <Utensils size={10} /> {item.note}
                        </span>
                      )}
                    </div>
                    <button 
                      onClick={() => deleteItem(item.id)} 
                      className="p-2.5 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all hover:bg-red-50 dark:hover:bg-red-900/10 rounded-xl"
                    >
                      <Trash2 size={18}/>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {completedItems.length > 0 && (
            <div className="pt-6">
              <button 
                onClick={() => setIsCompletedExpanded(!isCompletedExpanded)} 
                className="flex items-center gap-2 text-xs font-black uppercase text-gray-400 px-2 mb-5 tracking-widest hover:text-gray-600 transition-colors"
              >
                {isCompletedExpanded ? <ChevronUp size={16}/> : <ChevronDown size={16}/>} 
                Markerade Varor ({completedItems.length})
              </button>
              {isCompletedExpanded && (
                <div className="bg-white/40 dark:bg-gray-900/40 rounded-[2rem] overflow-hidden border dark:border-gray-800 backdrop-blur-sm">
                  {(completedItems as GroceryItem[]).map(item => (
                    <div key={item.id} className="flex items-center gap-5 p-5 opacity-40 border-b last:border-0 dark:border-gray-800">
                      <button 
                        onClick={() => toggleItem(item.id, false)} 
                        className="w-7 h-7 rounded-xl bg-primary flex items-center justify-center shadow-lg shadow-primary/20 active:scale-90 transition-all"
                      >
                        <Check size={18} className="text-black stroke-[3]"/>
                      </button>
                      <p className="flex-1 font-bold dark:text-white text-base line-through decoration-2">{item.name}</p>
                      <button 
                        onClick={() => deleteItem(item.id)} 
                        className="p-2.5 text-gray-400 hover:text-red-500 rounded-xl transition-colors"
                      >
                        <Trash2 size={18}/>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>


      {/* URL Import Vy */}
      {view === 'import-url' && (
        <div className="fixed inset-0 bg-white dark:bg-gray-950 z-[150] flex flex-col animate-in slide-in-from-right duration-300">
          <header className="px-6 py-6 border-b dark:border-gray-800 flex items-center justify-between">
            <button onClick={() => setView('main')} className="p-3 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-2xl dark:text-white"><X /></button>
            <h2 className="font-black text-xl dark:text-white italic tracking-tighter">Hämta från länk</h2>
            <div className="w-12" />
          </header>
          <main className="p-8 space-y-8 max-w-xl mx-auto w-full">
            <div className="space-y-3">
              <label className="text-[10px] font-black uppercase text-gray-400 tracking-widest px-1">Klistra in länk till recept</label>
              <div className="flex gap-3">
                <input 
                  type="text" 
                  autoFocus
                  placeholder="https://exempel.se/recept..."
                  className="flex-1 p-5 bg-gray-50 dark:bg-gray-900 rounded-3xl border-none focus:ring-2 ring-primary dark:text-white shadow-inner"
                  id="recipe-url-input"
                />
                <button 
                  onClick={async () => {
                    const input = document.getElementById('recipe-url-input') as HTMLInputElement;
                    if (!input.value) return;
                    setIsProcessing(true);
                    setProcessingLabel('Hämtar recept...');
                    try {
                      const res = await extractFromUrl(input.value);
                      if (res.items.length > 0) {
                        addExtractedItems(res.items);
                        setView('main');
                      }
                    } catch (e) { console.error(e); }
                    finally { setIsProcessing(false); }
                  }}
                  className="bg-primary text-black px-8 rounded-3xl font-black shadow-xl shadow-primary/20 active:scale-95 transition-all"
                >
                  {isProcessing ? <Loader2 className="animate-spin" /> : 'Hämta'}
                </button>
              </div>
            </div>
            
            <div className="p-6 bg-primary/5 dark:bg-primary/10 rounded-[2rem] border-2 border-primary/20 space-y-3">
              <h4 className="font-black text-primary-dark dark:text-primary flex items-center gap-2">
                <Settings2 size={18} />
                Hur fungerar det?
              </h4>
              <p className="text-sm text-gray-600 dark:text-gray-400 font-bold leading-relaxed">
                Vår AI läser av innehållet på sidan du anger, hittar alla ingredienser och sorterar dem direkt i rätt butikskategorier. Perfekt för när du hittat en spännande maträtt online!
              </p>
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
