//  Firebase Config
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

//  Prevent double initialization
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

//  Global references
const auth = firebase.auth();
const db = firebase.firestore();
const storage = typeof firebase.storage === "function" ? firebase.storage() : null;
// Global state
// const roomConfig = [
//   { room: "A1", type: "Standard", gender: "Female", prefix: "A" },
//   { room: "A2", type: "Standard", gender: "Female", prefix: "A" },
//   { room: "B2", type: "Standard", gender: "Female", prefix: "B" },

//   { room: "C1", type: "Standard", gender: "Male", prefix: "C" },
//   { room: "C2", type: "Standard", gender: "Male", prefix: "C" },
//   { room: "D2", type: "Standard", gender: "Male", prefix: "D" },
//   { room: "E2", type: "Standard", gender: "Male", prefix: "E" },
//   { room: "F2", type: "Standard", gender: "Male", prefix: "F" },
//   { room: "G2", type: "Standard", gender: "Mixed", prefix: "G" },

//   { room: "A3", type: "Premium", gender: "Female", prefix: "A" },
//   { room: "B3", type: "Premium", gender: "Female", prefix: "B" },

//   { room: "C3", type: "Premium", gender: "Male", prefix: "C" },
//   { room: "D3", type: "Premium", gender: "Male", prefix: "D" },
//   { room: "E3", type: "Premium", gender: "Male", prefix: "E" },
//   { room: "F3", type: "Premium", gender: "Male", prefix: "F" },
//   { room: "G3", type: "Premium", gender: "Male", prefix: "G" },
//   { room: "H3", type: "Premium", gender: "Male", prefix: "H" },
//   { room: "H2", type: "Premium", gender: "Mixed", prefix: "H" }
// ];
// const bedspaces = [];

// roomConfig.forEach(r => {
//   for (let i = 1; i <= 22; i++) {
//     bedspaces.push({
//       room: r.room,
//       bedNo: `${r.prefix}${i}`,
//       type: r.type,
//       gender: r.gender,
//       avail: "Available",
//       occupant: null
//     });
//   }
// });

// console.log("Total entries:", bedspaces.length);
// console.log(bedspaces);
// bedspaces.forEach(bed => {
//   db.collection("ROOMS")
//     .doc(`${bed.room}_${bed.bedNo}`)
//     .set(bed);
// });
