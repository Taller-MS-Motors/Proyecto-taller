import { Capacitor } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';

// Guarda datos de sesión (JWT) en el Keystore/Keychain nativo en vez de localStorage:
// si algún día aparece un XSS en el WebView, el token no queda expuesto en un storage
// que cualquier script de esa página puede leer. En web no existe un keychain del SO,
// así que se usa localStorage (mismo comportamiento de siempre ahí).
const nativo = Capacitor.isNativePlatform();

export async function secureGet(key: string): Promise<string | null> {
  if (!nativo) return localStorage.getItem(key);
  try {
    const v = await SecureStorage.get(key);
    return v == null ? null : String(v);
  } catch {
    return null;
  }
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (!nativo) { localStorage.setItem(key, value); return; }
  try { await SecureStorage.set(key, value); } catch { /* best-effort: la sesión ya vive en memoria */ }
}

export async function secureRemove(key: string): Promise<void> {
  if (!nativo) { localStorage.removeItem(key); return; }
  try { await SecureStorage.remove(key); } catch { /* nada que borrar */ }
}
