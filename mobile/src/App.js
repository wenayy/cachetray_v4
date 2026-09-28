import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut
} from 'firebase/auth';
import { auth } from './firebase';
import {
  loadCachedState,
  watchCloudState,
  writeCloudState
} from './cachetrayStore';
import { addTextClip, deleteClip, emptyState } from './model';
import {
  emulatorAccount,
  googleIosClientId,
  googleWebClientId,
  isConfigured,
  useEmulators
} from './config';

GoogleSignin.configure({
  webClientId: googleWebClientId || undefined,
  iosClientId: googleIosClientId || undefined
});

export default function App() {
  const [user, setUser] = useState(null);
  const [state, setState] = useState(emptyState());
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(true);
  const [syncLabel, setSyncLabel] = useState('Local cache');

  useEffect(() => {
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      if (nextUser) {
        loadCachedState(nextUser.uid).then(setState).finally(() => setBusy(false));
      } else {
        setState(emptyState());
        setBusy(false);
      }
    });
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    setSyncLabel('Connecting…');
    return watchCloudState(user.uid, (next) => {
      setState(next);
      setSyncLabel('Synced');
    }, (error) => setSyncLabel(error.message));
  }, [user]);

  const clips = useMemo(() => (state.clusters?.inbox?.notes || [])
    .filter((note) => note.type !== 'image'), [state]);

  async function login() {
    if (!isConfigured) return Alert.alert('Setup required', 'Fill in src/config.js first.');
    setBusy(true);
    try {
      if (useEmulators) {
        try {
          await createUserWithEmailAndPassword(auth, emulatorAccount.email, emulatorAccount.password);
        } catch (error) {
          if (error.code !== 'auth/email-already-in-use') throw error;
          await signInWithEmailAndPassword(auth, emulatorAccount.email, emulatorAccount.password);
        }
      } else {
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
        const result = await GoogleSignin.signIn();
        const idToken = result.data?.idToken || result.idToken;
        if (!idToken) throw new Error('Google did not return an ID token');
        await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
      }
    } catch (error) {
      Alert.alert('Sign-in failed', error.message);
    } finally {
      setBusy(false);
    }
  }

  async function save(next) {
    if (!user) return;
    setState(next);
    setSyncLabel('Syncing…');
    try {
      setState(await writeCloudState(user.uid, next));
      setSyncLabel('Synced');
    } catch (error) {
      setSyncLabel('Sync failed');
      Alert.alert('Could not sync', error.message);
    }
  }

  function addClip() {
    if (!draft.trim()) return;
    const next = addTextClip(state, draft);
    setDraft('');
    save(next);
  }

  async function logout() {
    await signOut(auth);
    if (!useEmulators) await GoogleSignin.signOut().catch(() => {});
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.authCard}>
          <Text style={styles.logo}>CacheTray</Text>
          <Text style={styles.tagline}>Your clips, wherever you work.</Text>
          <Text style={styles.privacy}>Cloud sync is opt-in. The Chrome extension remains local-only until you sign in.</Text>
          <Pressable style={styles.primary} onPress={login} disabled={busy}>
            {busy ? <ActivityIndicator color="#07110b" /> : <Text style={styles.primaryText}>{useEmulators ? 'Use local test account' : 'Continue with Google'}</Text>}
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View><Text style={styles.logoSmall}>CacheTray</Text><Text style={styles.status}>{syncLabel}</Text></View>
        <Pressable onPress={logout}><Text style={styles.signOut}>Sign out</Text></Pressable>
      </View>
      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={addClip}
          placeholder="Paste or type anything…"
          placeholderTextColor="#657168"
          style={styles.input}
          returnKeyType="done"
        />
        <Pressable style={styles.addButton} onPress={addClip}><Text style={styles.addText}>Add</Text></Pressable>
      </View>
      <FlatList
        data={clips}
        keyExtractor={(item) => `${item.type}:${item.id}`}
        contentContainerStyle={clips.length ? styles.list : styles.emptyList}
        ListEmptyComponent={<Text style={styles.empty}>No synced clips yet.</Text>}
        renderItem={({ item }) => (
          <Pressable style={styles.clip} onLongPress={() => save(deleteClip(state, item.id))}>
            <Text style={styles.type}>{item.type}</Text>
            <Text style={styles.content} numberOfLines={6}>{item.content || item.title || ''}</Text>
            <Text style={styles.hint}>Hold to delete</Text>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b0e0c' },
  authCard: { flex: 1, justifyContent: 'center', padding: 28 },
  logo: { color: '#d8ff77', fontSize: 34, fontWeight: '800', letterSpacing: -1 },
  tagline: { color: '#f2f5f2', fontSize: 20, marginTop: 10 },
  privacy: { color: '#8d988f', fontSize: 14, lineHeight: 21, marginTop: 14, marginBottom: 28 },
  primary: { minHeight: 52, borderRadius: 14, backgroundColor: '#c9f66f', alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#07110b', fontSize: 15, fontWeight: '800' },
  header: { paddingHorizontal: 18, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a302b' },
  logoSmall: { color: '#d8ff77', fontSize: 22, fontWeight: '800' },
  status: { color: '#728078', fontSize: 11, marginTop: 2 },
  signOut: { color: '#9ba69e', fontSize: 13 },
  composer: { flexDirection: 'row', gap: 8, padding: 12 },
  input: { flex: 1, minHeight: 46, borderRadius: 12, paddingHorizontal: 14, backgroundColor: '#151a16', color: '#f2f5f2', borderWidth: StyleSheet.hairlineWidth, borderColor: '#303831' },
  addButton: { width: 62, borderRadius: 12, backgroundColor: '#c9f66f', alignItems: 'center', justifyContent: 'center' },
  addText: { color: '#07110b', fontWeight: '800' },
  list: { padding: 12, gap: 10 },
  emptyList: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { color: '#657168' },
  clip: { padding: 15, borderRadius: 14, backgroundColor: '#141815', borderWidth: StyleSheet.hairlineWidth, borderColor: '#2b332c' },
  type: { color: '#8aa34f', fontSize: 10, fontWeight: '800', textTransform: 'uppercase', marginBottom: 7 },
  content: { color: '#edf2ed', fontSize: 15, lineHeight: 21 },
  hint: { color: '#59625b', fontSize: 10, marginTop: 10 }
});
