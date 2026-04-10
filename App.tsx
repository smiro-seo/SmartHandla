import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Menu, 
  Mic, 
  Camera, 
  Check, 
  X, 
  ShoppingCart, 
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
  Settings2
} from 'lucide-react';
import { GoogleGenAI, Modality, Blob, LiveServerMessage } from "@google/genai";
import { onAuthStateChanged, signInWithPopup, signOut, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { doc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { getDb, getAuthService, googleProvider } from './firebase';
import { GroceryItem, GroceryList, AppView, ExtractedItem, GroundingSource, UserProfile } from './types';
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
  
  const [userProfile, setUserProfile] = useState<UserProfile>(() => ({
    name: (typeof localStorage !== 'undefined' && localStorage.getItem('smarthandla_user_name')) || 'Gäst',
    syncCode: getStoredUserId(),
    isGoogleAccount: false
  }));

  const liveSessionRef = useRef<any>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const activeListIdRef = useRef(activeListId);
  const isInitialLoad = useRef(true);
  const audioSourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const nextStartTimeRef = useRef(0);
  const currentInputTranscriptionRef = useRef('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [processingLabel, setProcessingLabel] = useState('Bearbetar...');
  const [aisleOrder, setAisleOrder] = useState<string[]>([...VALID_AISLES]);
  const [isAisleEditorOpen, setIsAisleEditorOpen] = useState(false);

  const activeList = useMemo(() => lists.find(l => l.id === activeListId) || lists[0], [lists, activeListId]);

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

  const completedItems = useMemo(() => activeList.items.filter(i => i.checked), [activeList.items]);

  useEffect(() => {
    const timer = setTimeout(() => setIsFirebaseReady(true), 800);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!isFirebaseReady) return;
    try {
      const auth = getAuthService();
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
        await updateDoc(doc(db, 'users', userProfile.syncCode), { lists, name: userProfile.name, aisleOrder });
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

  // --- FUNKTIONER ---
  const addExtractedItems = (newItems: ExtractedItem[]) => {
    setLists(prev => (prev as GroceryList[]).map(list => {
      if (list.id === activeListIdRef.current) {
        const withIds = newItems.map(item => ({ 
          ...item, 
          id: generateId(), 
          checked: false, 
          aisle: item.aisle || 'Övrigt' 
        }));
        return { ...list, items: [...list.items, ...withIds] };
      }
      return list;
    }));
  };

  const isUrl = (value: string) => /^https?:\/\/.+/i.test(value.trim());

  const handleSmartAdd = async () => {
    if (!inputValue.trim()) return;
    const text = inputValue.trim();
    setInputValue('');
    setIsProcessing(true);

    if (isUrl(text)) {
      setProcessingLabel('Hämtar recept...');
      try {
        const res = await extractFromUrl(text);
        if (res.items.length > 0) addExtractedItems(res.items);
      } catch (e) { console.error("URL extraction error:", e); }
    } else {
      setProcessingLabel('Bearbetar...');
      try {
        const res = await smartMergeItems(text);
        addExtractedItems(res.items);
      } catch (e) { console.error("Smart add error:", e); }
    }

    setIsProcessing(false);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    setProcessingLabel('Analyserar bild...');
    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = reader.result as string;
        const items = await extractFromImage(base64);
        if (items.length > 0) {
          addExtractedItems(items);
        }
        setIsProcessing(false);
      };
      reader.readAsDataURL(file);
    } catch (e) {
      console.error("Image processing error:", e);
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
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioCtxRef.current = inputCtx;
      outputAudioCtxRef.current = outputCtx;
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
            const base64 = m.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const buffer = await decodeAudioData(decode(base64), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outputCtx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              audioSourcesRef.current.add(source);
            }
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
          responseModalities: [Modality.AUDIO],
          tools: [{ functionDeclarations: [addItemsFunctionDeclaration] }],
          systemInstruction: `Du är en svensk inköpsassistent. Tala och svara alltid på svenska. Lägg till varor när användaren pratar. Svara kort. Välj alltid avdelning från: ${VALID_AISLES.join(', ')}.`
        }
      });
      liveSessionRef.current = await sessionPromise;
    } catch (e) { setIsLiveMode(false); }
  };

  const handleLogin = async () => {
    try {
      const auth = getAuthService();
      await setPersistence(auth, browserLocalPersistence);
      await signInWithPopup(auth, googleProvider);
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
      l.id === activeListId ? { ...l, items: l.items.map(i => i.id === itemId ? { ...i, checked } : i) } : l
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
      {/* Hidden File Input for Camera/Gallery */}
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileUpload} 
        accept="image/*" 
        capture="environment"
        className="hidden" 
      />

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
                    {l.items.length}
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
        <button 
          onClick={() => setView('shopping')} 
          className="bg-primary text-black px-6 py-2.5 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20 hover:scale-105 active:scale-95 transition-all"
        >
          Handla
        </button>
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
                onClick={() => fileInputRef.current?.click()} 
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

      {/* Shopping Mode Vy */}
      {view === 'shopping' && (
        <div className="fixed inset-0 bg-white dark:bg-gray-950 z-[200] flex flex-col animate-in fade-in duration-300">
          <header className="px-6 py-5 border-b dark:border-gray-800 flex items-center justify-between bg-white/90 dark:bg-gray-950/90 backdrop-blur-md sticky top-0 z-10">
            <h2 className="font-black text-2xl dark:text-white tracking-tighter flex items-center gap-3">
              <ShoppingCart size={28} className="text-primary" />
              Handlar...
            </h2>
            <button 
              onClick={() => setView('main')} 
              className="px-6 py-2.5 bg-gray-900 dark:bg-primary text-white dark:text-black rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl active:scale-95 transition-all"
            >
              Avsluta
            </button>
          </header>
          <main className="flex-1 overflow-y-auto p-6 space-y-8 pb-24">
            {Object.keys(itemsByAisle).length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center opacity-40">
                <Check size={80} className="text-primary mb-6" />
                <p className="font-black text-2xl dark:text-white">Allt är klart!</p>
                <p className="text-sm dark:text-gray-400 mt-2">Du har bockat av alla varor på listan.</p>
                <button 
                  onClick={() => setView('main')}
                  className="mt-10 px-10 py-4 bg-primary text-black font-black rounded-2xl shadow-xl shadow-primary/20"
                >
                  Tillbaka till listan
                </button>
              </div>
            ) : (
              sortedAisleEntries.map(([aisle, items]) => (
                <div key={aisle} className="space-y-4">
                  <div className="flex items-center gap-3 px-2">
                    <div className="w-1.5 h-8 bg-primary rounded-full" />
                    <h3 className="text-xs font-black uppercase text-gray-500 tracking-[0.3em]">{aisle}</h3>
                  </div>
                  <div className="grid gap-4">
                    {(items as GroceryItem[]).map(item => (
                      <div 
                        key={item.id} 
                        onClick={() => toggleItem(item.id, true)}
                        className="flex items-center gap-6 p-6 bg-gray-50 dark:bg-gray-900 rounded-3xl border dark:border-gray-800 active:scale-[0.98] transition-all cursor-pointer shadow-sm"
                      >
                        <div className="w-10 h-10 rounded-2xl border-4 border-gray-200 dark:border-gray-800 flex items-center justify-center bg-white dark:bg-gray-950">
                          {item.checked && <Check size={24} className="text-primary stroke-[4]" />}
                        </div>
                        <div className="flex-1">
                          <p className="text-xl font-black dark:text-white leading-none">{item.name}</p>
                          {item.quantity && <p className="text-xs font-black text-primary-dark dark:text-primary uppercase tracking-tighter mt-1">{item.quantity}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </main>
        </div>
      )}

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
