const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const users = {};       // socket.id -> username
const rooms = {};       // room -> [socket.id]

app.use(express.static('public')); // frontend ada di folder public/

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('set-username', (username) => {
        users[socket.id] = username;
        broadcastUsernames();
    });

    socket.on('create or join', (room) => {
        const clients = io.sockets.adapter.rooms.get(room);
        const numClients = clients ? clients.size : 0;

        socket.join(room);
        rooms[room] = rooms[room] || [];
        rooms[room].push(socket.id);

        if (numClients === 0) {
            socket.emit('created', room, socket.id);
        } else {
            socket.emit('joined', room, socket.id);
            socket.to(room).emit('join', room);

            // Broadcast ke semua: lama dan baru
            const participants = Array.from(clients || []);
            participants.forEach(id => {
                if (id !== socket.id) {
                    socket.emit('ready', id);          // ke peserta baru
                    io.to(id).emit('ready', socket.id); // ke peserta lama
                }
            });
        }
    });

    socket.on('message', (message, toId, roomId) => {
        if (toId) {
            io.to(toId).emit('message', message, socket.id);
        } else {
            socket.to(roomId).emit('message', message, socket.id);
        }
    });

    socket.on('leave room', (room) => {
        socket.leave(room);
        socket.to(room).emit('message', { type: 'leave' }, socket.id);
        socket.emit('left room', room);

        if (rooms[room]) {
            rooms[room] = rooms[room].filter(id => id !== socket.id);
        }
    });

    socket.on('kickout', (targetSocketId, room) => {
        io.to(targetSocketId).emit('kickout', targetSocketId);
        io.to(room).emit('message', { type: 'leave' }, targetSocketId);
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        Object.keys(rooms).forEach(room => {
            if (rooms[room].includes(socket.id)) {
                rooms[room] = rooms[room].filter(id => id !== socket.id);
                socket.to(room).emit('message', { type: 'leave' }, socket.id);
            }
        });
        delete users[socket.id];
        broadcastUsernames();
    });

    function broadcastUsernames() {
        io.emit('usernames', users);
    }
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
