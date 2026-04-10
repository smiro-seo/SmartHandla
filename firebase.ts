import { initializeApp, getApp, getApps } from "firebase/app";
import { getFirestore } from 'firebase/firestore';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyDy6oA0J9josLcoyp1Zb4N-yhFSmOYib_o",
  // Use the current hostname as authDomain in production so the /__/auth/* proxy
  // on the Cloudflare domain keeps the entire OAuth redirect chain on one origin.
  // This is what makes iOS PWA auth work (no cross-context redirect to Safari).
  authDomain: (typeof window !== 'undefined' && window.location.hostname !== 'localhost')
    ? window.location.host
    : 'smarthandla.firebaseapp.com',
  projectId: "smarthandla",
  storageBucket: "smarthandla.firebasestorage.app",
  messagingSenderId: "505416231137",
  appId: "1:505416231137:web:1d4b5f56304d7c3dd8efa0"
};

// Initialize Firebase only if it hasn't been already
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

export const getDb = () => getFirestore(app);
export const getAuthService = () => getAuth(app);
export const googleProvider = new GoogleAuthProvider();
