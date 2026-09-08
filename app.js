// 1. Firebase Initialization
const firebaseConfig = {
  apiKey: "AIzaSyB8-vuazeaFxNsaRvXmrBx6LfvlJ8atyoY",
  authDomain: "blink1-useless.firebaseapp.com",
  databaseURL: "https://blink1-useless-default-rtdb.firebaseio.com",
  projectId: "blink1-useless",
  storageBucket: "blink1-useless.firebasestorage.app",
  messagingSenderId: "280806430504",
  appId: "1:280806430504:web:172c3344762029cc0ae21d"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// State variables
let myPlayerId = null;
let roomCode = null;
let myName = "Player";
let myMeter = 0; // 0 to 100
let decayRate = 2.0; // Decay speed per tick
let isBlinking = false;
let gameStatus = "waiting"; // "waiting", "countdown", "playing", "ended"
let decayInterval = null;

// DOM references
const lobbyScreen = document.getElementById("lobby-screen");
const gameScreen = document.getElementById("game-screen");
const p1Bar = document.getElementById("p1-bar");
const p2Bar = document.getElementById("p2-bar");
const p1Label = document.getElementById("p1-label");
const p2Label = document.getElementById("p2-label");
const p1Pct = document.getElementById("p1-pct");
const p2Pct = document.getElementById("p2-pct");
const blinkAlert = document.getElementById("blink-alert");
const winnerBanner = document.getElementById("winner-banner");
const startBtn = document.getElementById("start-btn");
const countdownBanner = document.getElementById("countdown-banner");
const statusBadge = document.getElementById("game-status");
const videoElement = document.getElementById("webcam");
const leaderboardList = document.getElementById("leaderboard-list");

// Load Leaderboard on boot
loadGlobalLeaderboard();

function loadGlobalLeaderboard() {
  db.ref("leaderboard").orderByChild("wins").limitToLast(5).on("value", (snapshot) => {
    leaderboardList.innerHTML = "";
    const players = [];
    snapshot.forEach((child) => {
      players.push({ name: child.key, wins: child.val().wins });
    });
    players.reverse();

    if (players.length === 0) {
      leaderboardList.innerHTML = "<li>No champions yet. Be the first!</li>";
      return;
    }

    players.forEach((p) => {
      const li = document.createElement("li");
      li.innerText = `${p.name}: ${p.wins} wins`;
      leaderboardList.appendChild(li);
    });
  });
}

// Handle Room Join / Create
document.getElementById("join-btn").addEventListener("click", async () => {
  myName = document.getElementById("player-name").value.trim() || "Player";
  roomCode = document.getElementById("room-id").value.trim();
  const selectedDecay = parseFloat(document.querySelector('input[name="decay"]:checked').value);

  if (!roomCode) return alert("Please enter a room code!");

  const roomRef = db.ref(`rooms/${roomCode}`);
  const snapshot = await roomRef.once("value");
  const roomData = snapshot.val();

  if (!roomData) {
    // Player 1 creates room
    myPlayerId = "p1";
    decayRate = selectedDecay;
    await roomRef.set({
      state: "waiting",
      decay: decayRate,
      winner: null,
      players: {
        p1: { name: myName, meter: 0 }
      }
    });
    roomRef.onDisconnect().remove();
  } else if (!roomData.players || !roomData.players.p2) {
    // Player 2 joins
    myPlayerId = "p2";
    decayRate = roomData.decay;
    roomRef.onDisconnect().cancel();
    await roomRef.child("players/p2").set({ name: myName, meter: 0 });
    roomRef.child("players/p2").onDisconnect().remove();
    roomRef.child("players/p1").onDisconnect().remove();
  } else {
    return alert("Room is already full!");
  }

  lobbyScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");
  document.getElementById("room-display").innerText = `Room: ${roomCode}`;

  listenToRoom();
  startWebcamAndDetection();
});

// Sync Room State
function listenToRoom() {
  const roomRef = db.ref(`rooms/${roomCode}`);

  roomRef.on("value", (snapshot) => {
    const data = snapshot.val();
    if (!data || !data.players) {
      if (gameStatus !== "ended") {
        alert("Opponent left or room closed.");
        location.reload();
      }
      return;
    }

    // Render Meters & Names
    if (data.players.p1) {
      p1Label.innerText = data.players.p1.name;
      p1Pct.innerText = `${Math.round(data.players.p1.meter)}%`;
      p1Bar.style.width = `${data.players.p1.meter}%`;
    }
    if (data.players.p2) {
      p2Label.innerText = data.players.p2.name;
      p2Pct.innerText = `${Math.round(data.players.p2.meter)}%`;
      p2Bar.style.width = `${data.players.p2.meter}%`;
    }

    // Host controls the Start Button visibility
    if (myPlayerId === "p1" && data.players.p2 && data.state === "waiting") {
      startBtn.classList.remove("hidden");
      statusBadge.innerText = "Ready to start!";
    }

    // Countdown State Sync
    if (data.state === "countdown" && gameStatus !== "countdown") {
      gameStatus = "countdown";
      startBtn.classList.add("hidden");
      runCountdownUI();
    }

    // Playing State Sync
    if (data.state === "playing" && gameStatus !== "playing") {
      gameStatus = "playing";
      statusBadge.innerText = "BLINK FAST!";
      startDecayEngine();
    }

    // Winner detected
    if (data.winner && gameStatus !== "ended") {
      handleGameOver(data.winner);
    }
  });
}

// Host triggers the game start sequence
startBtn.addEventListener("click", () => {
  db.ref(`rooms/${roomCode}`).update({ state: "countdown" });
});

function runCountdownUI() {
  countdownBanner.classList.remove("hidden");
  let count = 3;
  countdownBanner.innerText = count;

  const timer = setInterval(() => {
    count--;
    if (count > 0) {
      countdownBanner.innerText = count;
    } else if (count === 0) {
      countdownBanner.innerText = "GO!";
      if (myPlayerId === "p1") {
        db.ref(`rooms/${roomCode}`).update({ state: "playing" });
      }
    } else {
      clearInterval(timer);
      countdownBanner.classList.add("hidden");
    }
  }, 1000);
}

// Continuous Meter Drain
function startDecayEngine() {
  if (decayInterval) clearInterval(decayInterval);

  decayInterval = setInterval(() => {
    if (gameStatus !== "playing") {
      clearInterval(decayInterval);
      return;
    }

    if (myMeter > 0) {
      myMeter = Math.max(0, myMeter - decayRate);
      db.ref(`rooms/${roomCode}/players/${myPlayerId}/meter`).set(myMeter);
    }
  }, 100);
}

// Handle Blink Detection via MediaPipe
function calculateEAR(top, bottom, left, right) {
  const vertical = Math.hypot(top.x - bottom.x, top.y - bottom.y);
  const horizontal = Math.hypot(left.x - right.x, left.y - right.y);
  return vertical / horizontal;
}

function onResults(results) {
  if (gameStatus !== "playing" || !results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) return;

  const landmarks = results.multiFaceLandmarks[0];
  const leftEAR = calculateEAR(landmarks[159], landmarks[145], landmarks[33], landmarks[133]);
  const rightEAR = calculateEAR(landmarks[386], landmarks[374], landmarks[362], landmarks[263]);
  const avgEAR = (leftEAR + rightEAR) / 2;

  if (avgEAR < 0.21) {
    if (!isBlinking) {
      isBlinking = true;
      pushMeterUp();
      blinkAlert.style.display = "block";
    }
  } else {
    isBlinking = false;
    blinkAlert.style.display = "none";
  }
}

// Each blink adds +7% to your meter
function pushMeterUp() {
  myMeter = Math.min(100, myMeter + 7.5);
  db.ref(`rooms/${roomCode}/players/${myPlayerId}/meter`).set(myMeter);

  if (myMeter >= 100 && gameStatus === "playing") {
    db.ref(`rooms/${roomCode}`).update({
      winner: myName,
      state: "ended"
    });
  }
}

// Game Over & Global Leaderboard Write
async function handleGameOver(winnerName) {
  gameStatus = "ended";
  if (decayInterval) clearInterval(decayInterval);

  statusBadge.innerText = "Finished";
  winnerBanner.innerText = `🏆 ${winnerName} Wins!`;
  winnerBanner.classList.remove("hidden");

  // Only the winning client writes their win to avoid double counts
  if (winnerName === myName) {
    const leaderRef = db.ref(`leaderboard/${myName}/wins`);
    await leaderRef.transaction((currentWins) => (currentWins || 0) + 1);
  }

  // Auto clean room after 8 seconds
  setTimeout(() => {
    db.ref(`rooms/${roomCode}`).remove();
  }, 8000);
}

// Start Front-facing Webcam
function startWebcamAndDetection() {
  const faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
  });

  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });
  faceMesh.onResults(onResults);

  const camera = new Camera(videoElement, {
    onFrame: async () => {
      await faceMesh.send({ image: videoElement });
    },
    facingMode: "user",
    width: 320,
    height: 240
  });

  camera.start();
}
