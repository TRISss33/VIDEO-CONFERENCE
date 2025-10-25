'use strict';

class Webrtc extends EventTarget {
    constructor(socket, pcConfig = null, logging = { log: true, warn: true, error: true }) {
        super();
        this.room;
        this.socket = socket;
        this.pcConfig = pcConfig;

        this._myId = null;
        this.pcs = {}; // Peer connections
        this.streams = {};
        this.currentRoom;
        this.inCall = false;
        this.isReady = false; // At least 2 users are in room
        this.isInitiator = false; // Initiates connections if true
        this._isAdmin = false; // Should be checked on the server
        this._localStream = null;
        this.usernames = {}; // <-- NEW

        // Manage logging
        this.log = logging.log ? console.log : () => {};
        this.warn = logging.warn ? console.warn : () => {};
        this.error = logging.error ? console.error : () => {};

        // Initialize socket.io listeners
        this._onSocketListeners();
    }

    _emit(eventName, details) {
        this.dispatchEvent(new CustomEvent(eventName, { detail: details }));
    }

    get localStream() { return this._localStream; }
    get myId() { return this._myId; }
    get isAdmin() { return this._isAdmin; }
    get roomId() { return this.room; }
    get participants() { return Object.keys(this.pcs); }

    gotStream() {
        if (this.room) {
            this._sendMessage({ type: 'gotstream' }, null, this.room);
        } else {
            this.warn('Should join room before sending stream');
            this._emit('notification', { notification: `Should join room before sending a stream.` });
        }
    }

    joinRoom(room) {
        if (this.room) {
            this.warn('Leave current room before joining a new one');
            this._emit('notification', { notification: `Leave current room before joining a new one` });
            return;
        }
        if (!room) {
            this.warn('Room ID not provided');
            this._emit('notification', { notification: `Room ID not provided` });
            return;
        }
        this.socket.emit('create or join', room);
    }

    leaveRoom() {
        if (!this.room) {
            this.warn('You are currently not in a room');
            this._emit('notification', { notification: `You are currently not in a room` });
            return;
        }
        this.isInitiator = false;
        this.socket.emit('leave room', this.room);
    }

    getLocalStream(audioConstraints, videoConstraints) {
        return navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: videoConstraints })
            .then((stream) => {
                this.log('Got local stream.');
                this._localStream = stream;
                return stream;
            })
            .catch(() => {
                this.error("Can't get usermedia");
                this._emit('error', { error: new Error(`Can't get usermedia`) });
            });
    }

    _connect(socketId) {
        if (typeof this._localStream !== 'undefined' && this.isReady) {
            this.log('Create peer connection to ', socketId);
            this._createPeerConnection(socketId);
            this.pcs[socketId].addStream(this._localStream);

            if (this.isInitiator) {
                this.log('Creating offer for ', socketId);
                this._makeOffer(socketId);
            }
        } else {
            this.warn('NOT connecting');
        }
    }

    _onSocketListeners() {
        this.log('socket listeners initialized');

        this.socket.on('created', (room, socketId) => {
            this.room = room;
            this._myId = socketId;
            this.isInitiator = true;
            this._isAdmin = true;
            this._emit('createdRoom', { roomId: room });
        });

        this.socket.on('joined', (room, socketId) => {
            this.log('joined: ' + room);
            this.room = room;
            this.isReady = true;
            this._myId = socketId;
            this._emit('joinedRoom', { roomId: room });
        });

        this.socket.on('left room', (room) => {
            if (room === this.room) {
                this.warn(`Left the room ${room}`);
                this.room = null;
                this._removeUser();
                this._emit('leftRoom', { roomId: room });
            }
        });

        this.socket.on('join', (room) => {
            this.log('Incoming request to join room: ' + room);
            this.isReady = true;
            this.dispatchEvent(new Event('newJoin'));
        });

        this.socket.on('ready', (user) => {
            this.log('User: ', user, ' joined room');
            if (user !== this._myId && this.inCall) this.isInitiator = true;
        });

        this.socket.on('kickout', (socketId) => {
            this.log('kickout user: ', socketId);
            if (socketId === this._myId) {
                this.dispatchEvent(new Event('kicked'));
                this._removeUser();
            } else {
                this._removeUser(socketId);
            }
        });

        this.socket.on('log', (log) => {
            this.log.apply(console, log);
        });

        this.socket.on('usernames', (map) => {
            this.usernames = map;
        });

        this.socket.on('message', (message, socketId) => {
            this.log('From', socketId, ' received:', message.type);
            if (message.type === 'leave') {
                this.log(socketId, 'Left the call.');
                this._removeUser(socketId);
                this.isInitiator = true;
                this._emit('userLeave', { socketId: socketId });
                return;
            }

            if (this.pcs[socketId] && this.pcs[socketId].connectionState === 'connected') {
                this.log('Connection with ', socketId, 'is already established');
                return;
            }

            switch (message.type) {
                case 'gotstream':
                    this._connect(socketId);
                    break;
                case 'offer':
                    if (!this.pcs[socketId]) this._connect(socketId);
                    this.pcs[socketId].setRemoteDescription(new RTCSessionDescription(message));
                    this._answer(socketId);
                    break;
                case 'answer':
                    this.pcs[socketId].setRemoteDescription(new RTCSessionDescription(message));
                    break;
                case 'candidate':
                    this.inCall = true;
                    const candidate = new RTCIceCandidate({
                        sdpMLineIndex: message.label,
                        candidate: message.candidate,
                    });
                    this.pcs[socketId].addIceCandidate(candidate);
                    break;
            }
        });
    }

    _sendMessage(message, toId = null, roomId = null) {
        this.socket.emit('message', message, toId, roomId);
    }

    _createPeerConnection(socketId) {
        try {
            if (this.pcs[socketId]) {
                this.warn('Connection with ', socketId, ' already established');
                return;
            }

            this.pcs[socketId] = new RTCPeerConnection(this.pcConfig);
            this.pcs[socketId].onicecandidate = this._handleIceCandidate.bind(this, socketId);
            this.pcs[socketId].ontrack = this._handleOnTrack.bind(this, socketId);

            this.log('Created RTCPeerConnnection for ', socketId);
        } catch (error) {
            this.error('RTCPeerConnection failed: ' + error.message);
            this._emit('error', { error: new Error(`RTCPeerConnection failed: ${error.message}`) });
        }
    }

    _handleIceCandidate(socketId, event) {
        this.log('icecandidate event');
        if (event.candidate) {
            this._sendMessage({
                type: 'candidate',
                label: event.candidate.sdpMLineIndex,
                id: event.candidate.sdpMid,
                candidate: event.candidate.candidate,
            }, socketId);
        }
    }

    _handleCreateOfferError(event) {
        this.error('ERROR creating offer');
        this._emit('error', { error: new Error('Error while creating an offer') });
    }

    _makeOffer(socketId) {
        this.log('Sending offer to ', socketId);
        this.pcs[socketId].createOffer(
            this._setSendLocalDescription.bind(this, socketId),
            this._handleCreateOfferError
        );
    }

    _answer(socketId) {
        this.log('Sending answer to ', socketId);
        this.pcs[socketId].createAnswer().then(
            this._setSendLocalDescription.bind(this, socketId),
            this._handleSDPError
        );
    }

    _setSendLocalDescription(socketId, sessionDescription) {
        this.pcs[socketId].setLocalDescription(sessionDescription);
        this._sendMessage(sessionDescription, socketId);
    }

    _handleSDPError(error) {
        this.log('Session description error: ' + error.toString());
        this._emit('error', { error: new Error(`Session description error: ${error.toString()}`) });
    }

    _handleOnTrack(socketId, event) {
        this.log('Remote stream added for ', socketId);
        if (this.streams[socketId]?.id !== event.streams[0].id) {
            this.streams[socketId] = event.streams[0];
            this._emit('newUser', { socketId, stream: event.streams[0] });
        }
    }

    _handleUserLeave(socketId) {
        this.log(socketId, 'Left the call.');
        this._removeUser(socketId);
        this.isInitiator = false;
    }

    _removeUser(socketId = null) {
        if (!socketId) {
            for (const [key, value] of Object.entries(this.pcs)) {
                this.log('closing', value);
                value.close();
                delete this.pcs[key];
            }
            this.streams = {};
        } else {
            if (!this.pcs[socketId]) return;
            this.pcs[socketId].close();
            delete this.pcs[socketId];
            delete this.streams[socketId];
        }
        this._emit('removeUser', { socketId });
    }

    kickUser(socketId) {
        if (!this.isAdmin) {
            this._emit('notification', { notification: 'You are not an admin' });
            return;
        }
        this._removeUser(socketId);
        this.socket.emit('kickout', socketId, this.room);
    }
}
