const remoteVideo = document.getElementById('remote-video');
const localVideo = document.getElementById('local-video');
const joinOverlay = document.getElementById('join-overlay');
const callStatus = document.getElementById('call-status');
const connectionStatus = document.getElementById('connection-status');
const statusText = document.getElementById('status-text');
const btnJoin = document.getElementById('btn-join');
const btnMute = document.getElementById('btn-mute');
const btnCam = document.getElementById('btn-cam');
const btnLeave = document.getElementById('btn-leave');

let ws = null;
let localStream = null;
let peerConnection = null;
let audioMuted = false;
let cameraOff = false;

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const roomId = window.location.pathname.split('/join/')[1];

function setStatus(connected, text) {
  connectionStatus.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  statusText.textContent = text;
  callStatus.textContent = text;
  callStatus.className = `status-indicator ${connected ? 'active' : ''}`;
}

function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      setStatus(true, 'Connected to server');
      resolve();
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      handleServerMessage(data);
    };

    ws.onclose = () => setStatus(false, 'Disconnected');
    ws.onerror = () => {
      setStatus(false, 'Connection error');
      reject(new Error('WebSocket failed'));
    };
  });
}

function handleServerMessage(data) {
  switch (data.type) {
    case 'room-joined':
      setStatus(true, 'Joined room — waiting for interviewer');
      break;

    case 'signal':
      handleSignal(data.data);
      break;

    case 'peer-left':
      setStatus(false, 'Interviewer disconnected');
      remoteVideo.srcObject = null;
      break;

    case 'error':
      setStatus(false, data.message);
      break;
  }
}

async function startWebRTC(isInitiator) {
  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'signal',
        data: { candidate: event.candidate },
      }));
    }
  };

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection?.connectionState;
    if (state === 'connected') {
      setStatus(true, 'In call');
    } else if (state === 'disconnected' || state === 'failed') {
      setStatus(false, `Call ${state}`);
    }
  };

  if (isInitiator) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    ws.send(JSON.stringify({
      type: 'signal',
      data: { sdp: peerConnection.localDescription },
    }));
  }
}

async function handleSignal(signal) {
  if (!peerConnection) {
    await startWebRTC(false);
  }

  if (signal.sdp) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    if (signal.sdp.type === 'offer') {
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      ws.send(JSON.stringify({
        type: 'signal',
        data: { sdp: peerConnection.localDescription },
      }));
    }
  } else if (signal.candidate) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
  }
}

async function joinCall() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: true,
    });
    localVideo.srcObject = localStream;

    await connectWebSocket();

    ws.send(JSON.stringify({ type: 'join-room', roomId }));

    joinOverlay.classList.add('hidden');
    setStatus(true, 'Joined — connecting to interviewer');
  } catch (err) {
    console.error('Failed to join:', err);
    setStatus(false, `Error: ${err.message}`);
  }
}

function leaveCall() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
  joinOverlay.classList.remove('hidden');
  setStatus(false, 'Left call');
}

btnJoin.addEventListener('click', joinCall);
btnLeave.addEventListener('click', leaveCall);

btnMute.addEventListener('click', () => {
  audioMuted = !audioMuted;
  localStream?.getAudioTracks().forEach((t) => { t.enabled = !audioMuted; });
  btnMute.textContent = audioMuted ? 'Unmute' : 'Mute';
});

btnCam.addEventListener('click', () => {
  cameraOff = !cameraOff;
  localStream?.getVideoTracks().forEach((t) => { t.enabled = !cameraOff; });
  btnCam.textContent = cameraOff ? 'Camera On' : 'Camera Off';
});

if (!roomId) {
  setStatus(false, 'Invalid room link');
  btnJoin.disabled = true;
}
