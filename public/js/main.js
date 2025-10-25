'use strict';

const socket = io.connect();
const localVideo = document.querySelector('#localVideo-container video');
localVideo.muted = true; // penting: mute kamera sendiri

const videoGrid = document.querySelector('#videoGrid');
const notification = document.querySelector('#notification');

const notify = (message) => {
    notification.innerHTML = message;
    notification.classList.remove('d-none');
};

const pcConfig = {
    iceServers: [
        { urls: ['stun:stun.l.google.com:19302'] },
        {
            urls: 'turn:numb.viagenie.ca',
            credential: 'muazkh',
            username: 'webrtc@live.com',
        }
    ],
};

const webrtc = new Webrtc(socket, pcConfig, { log: true, warn: true, error: true });

const roomInput = document.querySelector('#roomId');
const nameInput = document.querySelector('#username');
const joinBtn = document.querySelector('#joinBtn');
const leaveBtn = document.querySelector('#leaveBtn');
const shareScreenBtn = document.getElementById('shareScreenBtn');
const muteBtn = document.getElementById('muteBtn');

let isMuted = false;

joinBtn.addEventListener('click', () => {
    const room = roomInput.value;
    const username = nameInput.value.trim();

    if (!room || !username) return notify('Room ID and Name are required');

    socket.emit('set-username', username);
    webrtc.joinRoom(room);
});

leaveBtn.addEventListener('click', () => webrtc.leaveRoom());

muteBtn.addEventListener('click', () => {
    const audioTracks = webrtc.localStream?.getAudioTracks();
    if (audioTracks && audioTracks.length > 0) {
        isMuted = !isMuted;
        audioTracks[0].enabled = !isMuted;

        muteBtn.classList.toggle('active', !isMuted);
        muteBtn.innerHTML = `<i class="bi ${isMuted ? 'bi-mic-mute-fill' : 'bi-mic-fill'}"></i>`;
    }
});

shareScreenBtn.addEventListener('click', async () => {
    try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];

        const senders = Object.values(webrtc.pcs)
            .map(pc => pc.getSenders().find(s => s.track.kind === 'video'));

        senders.forEach(sender => sender?.replaceTrack(screenTrack));

        screenTrack.onended = async () => {
            const cameraStream = await webrtc.getLocalStream(true, { width: 640, height: 480 });
            const cameraTrack = cameraStream.getVideoTracks()[0];

            senders.forEach(sender => sender?.replaceTrack(cameraTrack));
            localVideo.srcObject = cameraStream;
        };

        localVideo.srcObject = screenStream;
    } catch (err) {
        notify('Screen sharing failed: ' + err.message);
    }
});

webrtc.getLocalStream(true, { width: 640, height: 480 })
    .then(stream => {
        stream.getAudioTracks().forEach(track => track.enabled = true); // aktifkan audio
        localVideo.srcObject = stream;
    });

webrtc.addEventListener('createdRoom', (e) => {
    notify(`Room ${e.detail.roomId} was created`);
    webrtc.gotStream();
});

webrtc.addEventListener('joinedRoom', (e) => {
    notify(`Joined room ${e.detail.roomId}`);
    webrtc.gotStream();
});

webrtc.addEventListener('leftRoom', (e) => notify(`Left room ${e.detail.roomId}`));
webrtc.addEventListener('kicked', () => notify('You were kicked out'));

webrtc.addEventListener('notification', (e) => notify(e.detail.notification));
webrtc.addEventListener('removeUser', (e) => {
    const el = document.getElementById(e.detail.socketId);
    if (el) el.remove();
});

webrtc.addEventListener('newUser', (e) => {
    const { socketId, stream } = e.detail;
    const container = document.createElement('div');
    container.className = 'grid-item';
    container.id = socketId;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false; // biarkan peserta lain bisa terdengar
    video.srcObject = stream;

    const label = document.createElement('p');
    label.textContent = webrtc.usernames?.[socketId] || socketId;

    container.append(label, video);

    if (webrtc.isAdmin) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'kick_btn';
        kickBtn.textContent = 'Kick';
        kickBtn.addEventListener('click', () => webrtc.kickUser(socketId));
        container.append(kickBtn);
    }

    videoGrid.append(container);
});
