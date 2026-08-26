const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from 'public' folder
app.use(express.static('public'));

// ------------------------------
//  Data persistence (JSON files)
// ------------------------------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function readData(filename) {
  const file = path.join(DATA_DIR, filename);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function writeData(filename, data) {
  const file = path.join(DATA_DIR, filename);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ------------------------------
//  In‑memory state
// ------------------------------
let users = readData('users.json') || {};
let transactions = readData('transactions.json') || [];
let rooms = readData('rooms.json') || {
  room_10: {
    players: {},
    gameState: 'selection',
    round: 1,
    timer: 30,
    drawnNumbers: [],
    winners: [],
    spinCount: 0,
    cumulativeRotation: 0,
    potAmount: 0,
    totalBets: 0
  },
  room_20: {
    players: {},
    gameState: 'selection',
    round: 1,
    timer: 30,
    drawnNumbers: [],
    winners: [],
    spinCount: 0,
    cumulativeRotation: 0,
    potAmount: 0,
    totalBets: 0
  }
};

// Save data periodically (every 5 seconds)
setInterval(() => {
  writeData('users.json', users);
  writeData('transactions.json', transactions);
  writeData('rooms.json', rooms);
}, 5000);

// ------------------------------
//  Helper functions
// ------------------------------
function getRoom(roomName) {
  return rooms[roomName];
}

function getPlayer(room, username) {
  return room.players[username];
}

function updatePlayer(room, username, updates) {
  if (!room.players[username]) return;
  Object.assign(room.players[username], updates);
  // Broadcast updated players to room
  io.to(room.name).emit('playersUpdate', room.players);
}

// ------------------------------
//  Game logic
// ------------------------------
function startTimer(roomName) {
  const room = getRoom(roomName);
  if (!room) return;
  if (room.gameState !== 'selection') return;

  // Clear any existing interval
  if (room._timerInterval) {
    clearInterval(room._timerInterval);
    delete room._timerInterval;
  }

  room.timer = 30;
  io.to(roomName).emit('timerUpdate', room.timer);

  room._timerInterval = setInterval(() => {
    room.timer--;
    io.to(roomName).emit('timerUpdate', room.timer);

    if (room.timer <= 0) {
      clearInterval(room._timerInterval);
      delete room._timerInterval;

      // Count players with picks in current round
      const playersWithPick = Object.values(room.players).filter(
        p => p.pick !== null && p.round === room.round
      );

      if (playersWithPick.length >= 2) {
        // Enough players – start spin
        executeSpin(roomName);
      } else {
        // Not enough – reset timer
        room.timer = 30;
        io.to(roomName).emit('timerUpdate', room.timer);
        startTimer(roomName); // restart
      }
    }
  }, 1000);
}

function executeSpin(roomName) {
  const room = getRoom(roomName);
  if (!room) return;
  if (room.gameState === 'spinning') return;

  room.gameState = 'spinning';
  io.to(roomName).emit('gameStateUpdate', { gameState: 'spinning' });

  // Collect all taken numbers (from current round)
  const takenNumbers = Object.values(room.players)
    .filter(p => p.pick !== null && p.round === room.round)
    .map(p => p.pick);

  if (takenNumbers.length < 2) {
    // Reset to selection
    room.gameState = 'selection';
    io.to(roomName).emit('gameStateUpdate', { gameState: 'selection' });
    startTimer(roomName);
    return;
  }

  // Pick a random winning number
  const winningNumber = takenNumbers[Math.floor(Math.random() * takenNumbers.length)];
  const totalPlayers = takenNumbers.length;
  const totalPot = totalPlayers * room.players[Object.keys(room.players)[0]].bet; // assume same bet
  const prizePool = Math.floor(totalPot * 0.85); // 15% fee

  // Find winners
  const winners = Object.values(room.players)
    .filter(p => p.pick === winningNumber && p.round === room.round)
    .map(p => p.name);

  // Update room state
  room.drawnNumbers.push(winningNumber);
  room.winners = winners;
  room.spinCount++;
  room.potAmount = totalPot;
  room.gameState = 'results';

  // Broadcast spin result
  io.to(roomName).emit('spinResult', {
    winningNumber,
    winners,
    prizePool,
    totalPlayers,
    pot: totalPot
  });

  // Distribute winnings
  if (winners.length > 0) {
    const winAmount = Math.floor(prizePool / winners.length);
    winners.forEach(username => {
      if (users[username]) {
        users[username].mainWallet = (users[username].mainWallet || 0) + winAmount;
        io.to(roomName).emit('walletUpdate', { username, mainWallet: users[username].mainWallet });
      }
    });
  }

  // Reset round after 5 seconds (countdown)
  setTimeout(() => {
    // Clear picks and prepare next round
    Object.keys(room.players).forEach(name => {
      room.players[name].pick = null;
      room.players[name].ready = false;
      room.players[name].betDeducted = false;
      room.players[name].round = room.round + 1;
    });
    room.round++;
    room.drawnNumbers = [];
    room.winners = [];
    room.gameState = 'selection';
    room.timer = 30;
    room.potAmount = 0;
    io.to(roomName).emit('gameStateUpdate', { gameState: 'selection', round: room.round });
    io.to(roomName).emit('playersUpdate', room.players);
    io.to(roomName).emit('timerUpdate', room.timer);
    // Restart timer
    startTimer(roomName);
  }, 5000);
}

// ------------------------------
//  Socket.IO events
// ------------------------------
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // ---------- Authentication ----------
  socket.on('login', ({ username, password }) => {
    if (users[username] && users[username].password === password) {
      socket.username = username;
      socket.emit('loginSuccess', { username, mainWallet: users[username].mainWallet, playWallet: users[username].playWallet });
    } else {
      socket.emit('loginError', 'Invalid credentials');
    }
  });

  socket.on('signup', ({ username, password }) => {
    if (users[username]) {
      socket.emit('loginError', 'Username already exists');
      return;
    }
    users[username] = {
      password,
      mainWallet: 0,
      playWallet: 10, // welcome bonus
      pendingWithdrawal: 0,
      bonusClaimed: true
    };
    socket.username = username;
    socket.emit('loginSuccess', { username, mainWallet: 0, playWallet: 10 });
  });

  // ---------- Room management ----------
  socket.on('joinRoom', ({ room, bet }) => {
    if (!socket.username) return;
    const roomData = getRoom(room);
    if (!roomData) return;

    // Remove player from any previous room
    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
      const oldRoom = getRoom(socket.currentRoom);
      if (oldRoom && oldRoom.players[socket.username]) {
        delete oldRoom.players[socket.username];
        io.to(socket.currentRoom).emit('playersUpdate', oldRoom.players);
      }
    }

    socket.currentRoom = room;
    socket.join(room);

    // Add/update player
    roomData.players[socket.username] = {
      name: socket.username,
      pick: null,
      bet: bet,
      ready: false,
      betDeducted: false,
      round: roomData.round
    };

    // Send current room state to the client
    socket.emit('roomState', roomData);

    // Broadcast updated players to everyone in the room
    io.to(room).emit('playersUpdate', roomData.players);

    // Start timer if not already running
    if (roomData.gameState === 'selection' && !roomData._timerInterval) {
      startTimer(room);
    }
  });

  // ---------- Pick number ----------
  socket.on('pickNumber', ({ room, number }) => {
    if (!socket.username) return;
    const roomData = getRoom(room);
    if (!roomData) return;
    const player = roomData.players[socket.username];
    if (!player) return;
    if (roomData.gameState !== 'selection') return;

    // Check if number is already taken in current round
    const taken = Object.values(roomData.players)
      .filter(p => p.pick !== null && p.round === roomData.round)
      .map(p => p.pick);
    if (taken.includes(number)) {
      socket.emit('error', 'Number already taken');
      return;
    }

    // Update pick
    player.pick = number;
    player.round = roomData.round;
    player.ready = true;

    io.to(room).emit('playersUpdate', roomData.players);
  });

  // ---------- Transfer (Main -> Play) ----------
  socket.on('transferToPlay', ({ amount }) => {
    if (!socket.username) return;
    const user = users[socket.username];
    if (!user) return;
    const available = user.mainWallet - (user.pendingWithdrawal || 0);
    if (available < amount) {
      socket.emit('error', 'Insufficient main balance');
      return;
    }
    user.mainWallet -= amount;
    user.playWallet = (user.playWallet || 0) + amount;
    socket.emit('walletUpdate', { mainWallet: user.mainWallet, playWallet: user.playWallet });
  });

  // ---------- Withdraw request ----------
  socket.on('withdrawRequest', ({ amount }) => {
    if (!socket.username) return;
    const user = users[socket.username];
    if (!user) return;
    const available = user.mainWallet - (user.pendingWithdrawal || 0);
    if (available < amount) {
      socket.emit('error', 'Insufficient main balance');
      return;
    }
    // Lock amount in pending
    user.pendingWithdrawal = (user.pendingWithdrawal || 0) + amount;
    user.mainWallet -= amount;

    // Create transaction
    const tx = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      username: socket.username,
      type: 'withdraw',
      amount: amount,
      status: 'pending',
      timestamp: Date.now()
    };
    transactions.push(tx);
    socket.emit('walletUpdate', { mainWallet: user.mainWallet, pendingWithdrawal: user.pendingWithdrawal });
    // Notify admin (will be handled via admin page)
  });

  // ---------- Deposit request ----------
  socket.on('depositRequest', ({ amount }) => {
    if (!socket.username) return;
    // Create transaction
    const tx = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      username: socket.username,
      type: 'deposit',
      amount: amount,
      status: 'pending',
      timestamp: Date.now()
    };
    transactions.push(tx);
    socket.emit('transactionPending', { id: tx.id });
  });

  // ---------- Disconnect ----------
  socket.on('disconnect', () => {
    if (socket.username && socket.currentRoom) {
      const room = getRoom(socket.currentRoom);
      if (room && room.players[socket.username]) {
        delete room.players[socket.username];
        io.to(socket.currentRoom).emit('playersUpdate', room.players);
      }
    }
  });
});

// ------------------------------
//  Admin API (Socket.IO for admin panel)
// ------------------------------
io.on('connection', (socket) => {
  // Admin login (hardcoded for simplicity)
  socket.on('adminLogin', ({ password }) => {
    if (password === 'admin123') {
      socket.isAdmin = true;
      socket.emit('adminLoginSuccess');
      // Send initial data
      socket.emit('adminTransactions', transactions);
      socket.emit('adminUsers', users);
    } else {
      socket.emit('adminLoginError', 'Invalid admin password');
    }
  });

  // Admin approve/reject
  socket.on('adminApprove', ({ txId }) => {
    if (!socket.isAdmin) return;
    const tx = transactions.find(t => t.id === txId && t.status === 'pending');
    if (!tx) return;
    const user = users[tx.username];
    if (!user) return;

    if (tx.type === 'deposit') {
      user.playWallet = (user.playWallet || 0) + tx.amount;
    } else if (tx.type === 'withdraw') {
      // Already deducted from main and added to pending, now just clear pending
      user.pendingWithdrawal = Math.max(0, (user.pendingWithdrawal || 0) - tx.amount);
    }
    tx.status = 'approved';
    socket.emit('adminTransactions', transactions);
    // Notify the player
    io.emit('transactionUpdate', { id: tx.id, status: 'approved' });
  });

  socket.on('adminReject', ({ txId }) => {
    if (!socket.isAdmin) return;
    const tx = transactions.find(t => t.id === txId && t.status === 'pending');
    if (!tx) return;
    const user = users[tx.username];
    if (!user) return;

    if (tx.type === 'withdraw') {
      // Refund the locked amount
      user.mainWallet = (user.mainWallet || 0) + tx.amount;
      user.pendingWithdrawal = Math.max(0, (user.pendingWithdrawal || 0) - tx.amount);
    }
    tx.status = 'rejected';
    socket.emit('adminTransactions', transactions);
    io.emit('transactionUpdate', { id: tx.id, status: 'rejected' });
  });
});

// ------------------------------
//  Start server
// ------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Winzo server running on http://localhost:${PORT}`);
});