// 1. Firebase Configuration & Initialization
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

// 2. State Variables
let myPlayerId = null;
let roomCode = null;
let myName = "Player";
let myMeter = 0; // 0 to 100
let decayRate = 2.0; // Decay step per tick
let gameStatus = "waiting"; // "waiting", "countdown", "playing", "ended"
let decayInterval = null;

// 3. High-Precision Blink Engine Variables
let blinkFrameCounter = 0;
const MIN_CLOSED_FRAMES = 2;   // Eye must stay closed >= 2 frames (eliminates 1-frame motion blur glitches)
const BLINK_THRESHOLD = 0.19;    // Must drop below this to count as closed
const REOPEN_THRESHOLD = 0.25;   // Must reopen above this before another blink can register
let eyeIsClosedState = false;

// 4. DOM References
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

// Load Global Leaderboard on boot
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

// 5. Room Setup & Lifecycle
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
    // Auto-delete entire room if host closes tab while waiting alone
    roomRef.onDisconnect().remove();
  } else if (!roomData.players || !roomData.players.p2) {
    // Player 2 joins room
    myPlayerId = "p2";
    decayRate = roomData.decay;
    
    // Cancel the room-wide wipe on disconnect now that 2 people are here
    roomRef.onDisconnect().cancel();
    
    await roomRef.child("players/p2").set({ name: myName, meter: 0 });
    
    // Clear individual players if they leave
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

// 6. Real-time Firebase Sync
function listenToRoom() {
  const roomRef = db.ref(`rooms/${roomCode}`);

  roomRef.on("value", (snapshot) => {
    const data = snapshot.val();
    if (!data || !data.players) {
      if (gameStatus !== "ended") {
        alert("Opponent disconnected or room was removed.");
        location.reload();
      }
      return;
    }

    // Update Player 1 progress
    if (data.players.p1) {
      p1Label.innerText = data.players.p1.name;
      p1Pct.innerText = `${Math.round(data.players.p1.meter)}%`;
      p1Bar.style.width = `${data.players.p1.meter}%`;
    }

    // Update Player 2 progress
    if (data.players.p2) {
      p2Label.innerText = data.players.p2.name;
      p2Pct.innerText = `${Math.round(data.players.p2.meter)}%`;
      p2Bar.style.width = `${data.players.p2.meter}%`;
    }

    // Host controls the Start Match button
    if (myPlayerId === "p1" && data.players.p2 && data.state === "waiting") {
      startBtn.classList.remove("hidden");
      statusBadge.innerText = "Ready to start!";
    }

    // Handle Countdown State
    if (data.state === "countdown" && gameStatus !== "countdown") {
      gameStatus = "countdown";
      startBtn.classList.add("hidden");
      runCountdownUI();
    }

    // Handle Playing State
    if (data.state === "playing" && gameStatus !== "playing") {
      gameStatus = "playing";
      statusBadge.innerText = "BLINK FAST!";
      startDecayEngine();
    }

    // Handle Game Over
    if (data.winner && gameStatus !== "ended") {
      handleGameOver(data.winner);
    }
  });
}

// 7. Start Sequence & Countdown
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

// 8. Tug-Of-War Decay Engine
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

// 9. Extra-Accurate Dual-Point Eye Aspect Ratio (EAR) Math
function dist(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

function getAccurateEAR(eye, lm) {
  const p1 = lm[eye.left];
  const p4 = lm[eye.right];
  const p2 = lm[eye.top1];
  const p6 = lm[eye.bottom1];
  const p3 = lm[eye.top2];
  const p5 = lm[eye.bottom2];

  const vertical1 = dist(p2, p6);
  const vertical2 = dist(p3, p5);
  const horizontal = dist(p1, p4);

  if (horizontal === 0) return 0;
  return (vertical1 + vertical2) / (2.0 * horizontal);
}

// Rejects frame if head or phone is tilted/shaken horizontally
function isHeadFacingCamera(lm) {
  const nose = lm[1].x;
  const leftCheek = lm[234].x;
  const rightCheek = lm[454].x;

  const distToLeft = Math.abs(nose - leftCheek);
  const distToRight = Math.abs(nose - rightCheek);
  const ratio = distToLeft / (distToRight + 0.0001);

  return ratio > 0.45 && ratio < 2.2;
}

// 10. Frame-by-Frame MediaPipe Callback
function onResults(results) {
  if (gameStatus !== "playing" || !results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
    blinkAlert.style.display = "none";
    return;
  }

  const lm = results.multiFaceLandmarks[0];

  // Discard frame if phone or head is shaking horizontally
  if (!isHeadFacingCamera(lm)) {
    blinkFrameCounter = 0;
    return;
  }

  // 6-point eye landmark configuration
  const leftEyeData = { left: 33, right: 133, top1: 160, bottom1: 144, top2: 158, bottom2: 153 };
  const rightEyeData = { left: 362, right: 263, top1: 385, bottom1: 380, top2: 387, bottom2: 373 };

  const leftEAR = getAccurateEAR(leftEyeData, lm);
  const rightEAR = getAccurateEAR(rightEyeData, lm);
  const ear = (leftEAR + rightEAR) / 2.0;

  // Frame debounced state machine
  if (ear < BLINK_THRESHOLD) {
    blinkFrameCounter++;
    
    // Only fire when eyes stay closed across consecutive frames
    if (blinkFrameCounter >= MIN_CLOSED_FRAMES && !eyeIsClosedState) {
      eyeIsClosedState = true;
      pushMeterUp();
      blinkAlert.style.display = "block";
    }
  } else if (ear > REOPEN_THRESHOLD) {
    // Fully reset only after eyes open back up completely
    blinkFrameCounter = 0;
    eyeIsClosedState = false;
    blinkAlert.style.display = "none";
  }
}

// 11. Point Increment & Win Trigger
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

// 12. Match Conclusion & Leaderboard Write
async function handleGameOver(winnerName) {
  gameStatus = "ended";
  if (decayInterval) clearInterval(decayInterval);

  statusBadge.innerText = "Finished";
  winnerBanner.innerText = `🏆 ${winnerName} Wins!`;
  winnerBanner.classList.remove("hidden");

  // Only winner performs the increment to prevent duplicate writes
  if (winnerName === myName) {
    const leaderRef = db.ref(`leaderboard/${myName}/wins`);
    await leaderRef.transaction((currentWins) => (currentWins || 0) + 1);
  }

  // Auto clean room after 8 seconds
  setTimeout(() => {
    db.ref(`rooms/${roomCode}`).remove();
  }, 8000);
}

// 13. Mobile Front-Camera Initialization
function startWebcamAndDetection() {
  const faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
  });

  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: false, // Disables iris tracking for fast mobile performance
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
