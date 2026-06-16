const firebaseConfig = {
  apiKey: "AIzaSyCn4U1J18yfbrNO2KYbH7f6S30lEC7ClkA",
  authDomain: "citihub-example.firebaseapp.com",
  databaseURL: "https://citihub-example-default-rtdb.firebaseio.com",
  projectId: "citihub-example",
  storageBucket: "citihub-example.firebasestorage.app",
  messagingSenderId: "645032109193",
  appId: "1:645032109193:web:9c54f5ff633a7d5604d258",
  measurementId: "G-FPQ0XXSGT7"
};
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

// Firestore reference
const db = firebase.firestore();
const auth = firebase.auth();
const storage = typeof firebase.storage === "function" ? firebase.storage() : null;

try {
    if (typeof firebase.appCheck === "function") {
        const appCheck = firebase.appCheck();
        appCheck.activate("6Ldne6YsAAAAACXAl4DZZdSExxfJNzCkHso9Szw8", true);
    }
} catch (error) {
    console.warn("Firebase App Check could not be activated for admin pages:", error);
}
