// 1) Fill these with your Firebase project config (Project Settings → General → Web app)
const firebaseConfig = {
apiKey: "AIzaSyDC47Np4iSHqzI2_YMp9yOfgUMgtn5vVx4",
    authDomain: "spinwheel-4940d.firebaseapp.com",
    projectId: "spinwheel-4940d",
    storageBucket: "spinwheel-4940d.firebasestorage.app",
    messagingSenderId: "701220771542",
    appId: "1:701220771542:web:d7dcb35afdf7eaa7189b77"
};



firebase.initializeApp(firebaseConfig);

// 2) Globals
window.auth = firebase.auth();
window.db = firebase.firestore();
window.functions = firebase.functions();


