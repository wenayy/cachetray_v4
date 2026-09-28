// These are public application identifiers, not secrets. Use the same Firebase
// project as firebase-config.js in the Chrome extension.
export const firebaseConfig = {
  apiKey: 'AIzaSyAqZwfXq5BKuWwv12snyNzPhJGkw_YdcV4',
  authDomain: 'cachetray-3c67b.firebaseapp.com',
  projectId: 'cachetray-3c67b',
  appId: '',
  messagingSenderId: ''
};

// OAuth client of type "Web application" from the same Google/Firebase project.
export const googleWebClientId = '';
export const googleIosClientId = '';

// Local development works without Google or a real Firebase project.
export const useEmulators = false;
export const emulatorHost = '127.0.0.1';
export const emulatorAccount = {
  email: 'cachetray-local@example.test',
  password: 'cachetray-local-password'
};

export const isConfigured = useEmulators || Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && googleWebClientId
);
