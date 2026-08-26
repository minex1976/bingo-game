// Add this after the socket.io configuration
console.log('🚀 Server starting...');
console.log(`📁 Data directory: ${DATA_DIR}`);
console.log(`👥 Users loaded: ${Object.keys(users).length}`);
console.log(`📊 Transactions loaded: ${transactions.length}`);
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ===== CONFIGURE SOCKET.IO FOR RENDER =====
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // Force polling first, then upgrade to WebSocket
  transports: ['polling', 'websocket'],
  // Increase timeout for slow connections
  pingTimeout: 60000,
  pingInterval: 25000,
  // Allow upgrades
  allowUpgrades: true,
  // Cookie settings for sticky sessions
  cookie: {
    name: "io",
    httpOnly: true,
    sameSite: "lax"
  }
});

app.use(express.static('public'));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function readData(filename) {
  const file = path.join(DATA_DIR, filename);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeData(filename, data) {
  const file = path.join(DATA_DIR, filename);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

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
    totalBets: 0,
    timerInterval: null,
    isCountingDown: false
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
    totalBets: 0,
    timerInterval: null,
    isCountingDown: false
  }
};

setInterval(() => {
  writeData('users.json', users);
  writeData('transactions.json', transactions);
  writeData('rooms.json', rooms);
}, 5000);

function getRoom(roomName) { return rooms[roomName]; }

function stopTimer(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
  room.isCountingDown = false;
}

function startTimer(roomName) {
  const room = getRoom(roomName);
  if (!room) return;
  if (room.gameState !== 'selection') return;
  
  stopTimer(room);
  
  const playersWithPick = Object.values(room.players).filter(
    p => p.pick !== null && p.round === room.round
  );
  
  if (playersWithPick.length < 2) {
    room.timer = 30;
    io.to(roomName).emit('timerUpdate', room.timer);
    io.to(roomName).emit('statusUpdate', '⏳ Waiting for more players...');
    return;
  }
  
  room.timer = 30;
  room.isCountingDown = true;
  io.to(roomName).emit('timerUpdate', room.timer);
  io.to(roomName).emit('statusUpdate', '⏳ Timer started!');
  
  room.timerInterval = setInterval(() => {
    room.timer--;
    io.to(roomName).emit('timerUpdate', room.timer);
    
    if (room.timer <= 0) {
      stopTimer(room);
      const playersWithPickNow = Object.values(room.players).filter(
        p => p.pick !== null && p.round === room.round
      );
      if (playersWithPickNow.length >= 2) {
        executeSpin(roomName);
      } else {
        room.timer = 30;
        room.isCountingDown = false;
        io.to(roomName).emit('timerUpdate', room.timer);
        io.to(roomName).emit('statusUpdate', '⏳ Waiting for more players...');
      }
    }
  }, 1000);
}

function executeSpin(roomName) {
  const room = getRoom(roomName);
  if (!room) return;
  
  stopTimer(room);
  
  if (room.gameState === 'spinning') return;
  
  const playersWithPick = Object.values(room.players).filter(
    p => p.pick !== null && p.round === room.round
  );
  
  if (playersWithPick.length < 2) {
    room.gameState = 'selection';
    room.timer = 30;
    io.to(roomName).emit('gameStateUpdate', { gameState: 'selection' });
    io.to(roomName).emit('timerUpdate', room.timer);
    return;
  }
  
  room.gameState = 'spinning';
  io.to(roomName).emit('gameStateUpdate', { gameState: 'spinning' });
  
  const takenNumbers = playersWithPick.map(p => p.pick);
  const winningNumber = takenNumbers[Math.floor(Math.random() * takenNumbers.length)];
  const betAmount = Object.values(room.players)[0]?.bet || 10;
  const totalPot = takenNumbers.length * betAmount;
  const prizePool = Math.floor(totalPot * 0.85);
  
  const winners = Object.values(room.players)
    .filter(p => p.pick === winningNumber && p.round === room.round)
    .map(p => p.name);
  
  room.drawnNumbers.push(winningNumber);
  room.winners = winners;
  room.spinCount++;
  room.potAmount = totalPot;
  room.gameState = 'results';
  
  io.to(roomName).emit('spinResult', { 
    winningNumber, 
    winners, 
    prizePool, 
    totalPlayers: takenNumbers.length, 
    pot: totalPot 
  });
  
  if (winners.length > 0) {
    const winAmount = Math.floor(prizePool / winners.length);
    winners.forEach(username => {
      if (users[username]) {
        users[username].mainWallet = (users[username].mainWallet || 0) + winAmount;
        io.to(roomName).emit('walletUpdate', { 
          username, 
          mainWallet: users[username].mainWallet 
        });
      }
    });
  }
  
  setTimeout(() => {
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
    room.isCountingDown = false;
    
    io.to(roomName).emit('gameStateUpdate', { gameState: 'selection', round: room.round });
    io.to(roomName).emit('playersUpdate', room.players);
    io.to(roomName).emit('timerUpdate', room.timer);
    
    const playersWithPickAfterReset = Object.values(room.players).filter(
      p => p.pick !== null && p.round === room.round
    );
    if (playersWithPickAfterReset.length >= 2) {
      startTimer(roomName);
    } else {
      io.to(roomName).emit('statusUpdate', '⏳ Waiting for players...');
    }
  }, 5000);
}

// ===== SOCKET.IO EVENTS =====
io.on('connection', (socket) => {
  console.log('👤 Player connected:', socket.id);
  
  // Send connection confirmation
  socket.emit('connected', { status: 'ok', socketId: socket.id });
  
  socket.on('login', ({ username, password }) => {
    if (users[username] && users[username].password === password) {
      socket.username = username;
      socket.emit('loginSuccess', { 
        username, 
        mainWallet: users[username].mainWallet || 0, 
        playWallet: users[username].playWallet || 0 
      });
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
      playWallet: 10,
      pendingWithdrawal: 0,
      bonusClaimed: true
    };
    socket.username = username;
    socket.emit('loginSuccess', { username, mainWallet: 0, playWallet: 10 });
  });
  
  socket.on('joinRoom', ({ room, bet }) => {
    if (!socket.username) return;
    const roomData = getRoom(room);
    if (!roomData) return;
    
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
    
    roomData.players[socket.username] = {
      name: socket.username,
      pick: null,
      bet: bet,
      ready: false,
      betDeducted: false,
      round: roomData.round
    };
    
    socket.emit('roomState', roomData);
    io.to(room).emit('playersUpdate', roomData.players);
    
    if (roomData.gameState === 'selection' && !roomData.isCountingDown && !roomData.timerInterval) {
      const playerCount = Object.keys(roomData.players).length;
      if (playerCount >= 2) {
        startTimer(room);
      } else {
        roomData.timer = 30;
        io.to(room).emit('timerUpdate', roomData.timer);
        io.to(room).emit('statusUpdate', '⏳ Waiting for more players...');
      }
    }
  });
  
  socket.on('pickNumber', ({ room, number }) => {
    if (!socket.username) return;
    const roomData = getRoom(room);
    if (!roomData) return;
    const player = roomData.players[socket.username];
    if (!player || roomData.gameState !== 'selection') return;
    
    const taken = Object.values(roomData.players)
      .filter(p => p.pick !== null && p.round === roomData.round)
      .map(p => p.pick);
    
    if (number !== null && taken.includes(number)) {
      socket.emit('error', 'Number already taken');
      return;
    }
    
    player.pick = number;
    player.round = roomData.round;
    player.ready = number !== null;
    io.to(room).emit('playersUpdate', roomData.players);
    
    if (roomData.gameState === 'selection' && !roomData.isCountingDown && !roomData.timerInterval) {
      const playersWithPick = Object.values(roomData.players).filter(
        p => p.pick !== null && p.round === roomData.round
      );
      if (playersWithPick.length >= 2) {
        startTimer(room);
      }
    }
  });
  
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
    socket.emit('walletUpdate', { 
      mainWallet: user.mainWallet, 
      playWallet: user.playWallet 
    });
  });
  
  socket.on('withdrawRequest', ({ amount }) => {
    if (!socket.username) return;
    const user = users[socket.username];
    if (!user) return;
    const available = user.mainWallet - (user.pendingWithdrawal || 0);
    if (available < amount) {
      socket.emit('error', 'Insufficient balance');
      return;
    }
    user.pendingWithdrawal = (user.pendingWithdrawal || 0) + amount;
    user.mainWallet -= amount;
    
    const tx = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      username: socket.username,
      type: 'withdraw',
      amount: amount,
      status: 'pending',
      timestamp: Date.now()
    };
    transactions.push(tx);
    socket.emit('walletUpdate', { 
      mainWallet: user.mainWallet, 
      pendingWithdrawal: user.pendingWithdrawal 
    });
  });
  
  socket.on('depositRequest', ({ amount }) => {
    if (!socket.username) return;
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
  
  socket.on('disconnect', () => {
    console.log('❌ Player disconnected:', socket.id);
    if (socket.username && socket.currentRoom) {
      const room = getRoom(socket.currentRoom);
      if (room && room.players[socket.username]) {
        delete room.players[socket.username];
        io.to(socket.currentRoom).emit('playersUpdate', room.players);
        
        const playerCount = Object.keys(room.players).length;
        if (playerCount < 2 && room.isCountingDown) {
          stopTimer(room);
          room.timer = 30;
          io.to(socket.currentRoom).emit('timerUpdate', room.timer);
          io.to(socket.currentRoom).emit('statusUpdate', '⏳ Waiting for more players...');
        }
      }
    }
  });
});

// ===== ADMIN EVENTS =====
io.on('connection', (socket) => {
  socket.on('adminLogin', ({ password }) => {
    if (password === 'admin123') {
      socket.isAdmin = true;
      socket.emit('adminLoginSuccess');
      socket.emit('adminTransactions', transactions);
      socket.emit('adminUsers', users);
    } else {
      socket.emit('adminLoginError', 'Invalid password');
    }
  });
  
  socket.on('adminApprove', ({ txId }) => {
    if (!socket.isAdmin) return;
    const tx = transactions.find(t => t.id === txId && t.status === 'pending');
    if (!tx) return;
    const user = users[tx.username];
    if (!user) return;
    
    if (tx.type === 'deposit') {
      user.playWallet = (user.playWallet || 0) + tx.amount;
    } else if (tx.type === 'withdraw') {
      user.pendingWithdrawal = Math.max(0, (user.pendingWithdrawal || 0) - tx.amount);
    }
    tx.status = 'approved';
    socket.emit('adminTransactions', transactions);
    io.emit('transactionUpdate', { id: tx.id, status: 'approved' });
  });
  
  socket.on('adminReject', ({ txId }) => {
    if (!socket.isAdmin) return;
    const tx = transactions.find(t => t.id === txId && t.status === 'pending');
    if (!tx) return;
    const user = users[tx.username];
    if (!user) return;
    
    if (tx.type === 'withdraw') {
      user.mainWallet = (user.mainWallet || 0) + tx.amount;
      user.pendingWithdrawal = Math.max(0, (user.pendingWithdrawal || 0) - tx.amount);
    }
    tx.status = 'rejected';
    socket.emit('adminTransactions', transactions);
    io.emit('transactionUpdate', { id: tx.id, status: 'rejected' });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Bingo server running on http://localhost:${PORT}`);
  console.log(`📊 Admin panel at http://localhost:${PORT}/admin.html`);
  console.log(`🔌 Socket.IO configured with polling + WebSocket fallback`);
});
