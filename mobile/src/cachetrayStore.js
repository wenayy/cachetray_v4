import AsyncStorage from '@react-native-async-storage/async-storage';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { emptyState } from './model';

const cacheKey = (userId) => `cachetray.mobile.snapshot.v1.${userId}`;

export async function loadCachedState(userId) {
  const value = await AsyncStorage.getItem(cacheKey(userId));
  if (!value) return emptyState();
  try { return JSON.parse(value); } catch { return emptyState(); }
}

export function watchCloudState(userId, onState, onError) {
  const reference = doc(db, 'users', userId, 'cachetray', 'state');
  return onSnapshot(reference, async (snapshot) => {
    if (!snapshot.exists()) return;
    try {
      const next = JSON.parse(snapshot.data().payload);
      await AsyncStorage.setItem(cacheKey(userId), JSON.stringify(next));
      onState(next);
    } catch (error) {
      onError(error);
    }
  }, onError);
}

export async function writeCloudState(userId, state) {
  const next = { ...state, modifiedAt: Date.now() };
  await setDoc(doc(db, 'users', userId, 'cachetray', 'state'), {
    payload: JSON.stringify(next),
    modifiedAt: next.modifiedAt
  });
  await AsyncStorage.setItem(cacheKey(userId), JSON.stringify(next));
  return next;
}
