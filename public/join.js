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

let ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

async function loadIceConfig() {
  const res = await fetch('/api/ice-config');
  const data = await res.json();
  ICE_SERVERS = data.iceServers;
}

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
      setStatus(true, 'サーバー接続済み Connected to server');
      resolve();
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      handleServerMessage(data);
    };

    ws.onclose = () => setStatus(false, '切断 Disconnected');
    ws.onerror = () => {
      setStatus(false, '接続エラー Connection error');
      reject(new Error('WebSocket failed'));
    };
  });
}

function handleServerMessage(data) {
  switch (data.type) {
    case 'room-joined':
      setStatus(true, 'ルーム参加済み — 面談者の接続待ち Joined room — waiting for interviewer');
      break;

    case 'signal':
      handleSignal(data.data);
      break;

    case 'peer-left':
      setStatus(false, '面談者切断 Interviewer disconnected');
      remoteVideo.srcObject = null;
      break;

    case 'error':
      setStatus(false, data.message);
      break;
  }
}

async function startWebRTC(isInitiator) {
  console.log('[INTERVIEWEE] startWebRTC, initiator:', isInitiator);
  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  localStream.getTracks().forEach((track) => {
    console.log('[INTERVIEWEE] Adding local track:', track.kind, track.readyState);
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('[INTERVIEWEE] ICE candidate:', event.candidate.type, event.candidate.protocol);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'signal',
          data: { candidate: event.candidate },
        }));
      }
    } else {
      console.log('[INTERVIEWEE] ICE gathering complete');
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.log('[INTERVIEWEE] ICE connection state:', peerConnection.iceConnectionState);
  };

  peerConnection.ontrack = (event) => {
    console.log('[INTERVIEWEE] ontrack fired:', event.track.kind, 'streams:', event.streams?.length);
    if (event.streams?.[0]) {
      remoteVideo.srcObject = event.streams[0];
    } else {
      if (!remoteVideo.srcObject) {
        remoteVideo.srcObject = new MediaStream();
      }
      remoteVideo.srcObject.addTrack(event.track);
    }
    remoteVideo.play().catch((e) => console.warn('[INTERVIEWEE] play() failed:', e.message));
    const tracks = (remoteVideo.srcObject?.getTracks() || []).map(t => `${t.kind}:${t.readyState}`);
    console.log('[INTERVIEWEE] Remote stream tracks:', tracks.join(', '));
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection?.connectionState;
    console.log('[INTERVIEWEE] Connection state:', state);
    if (state === 'connected') {
      setStatus(true, '通話中 In call');
    } else if (state === 'disconnected' || state === 'failed') {
      setStatus(false, `通話${state} Call ${state}`);
    }
  };

  if (isInitiator) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    console.log('[INTERVIEWEE] Offer created and sent');
    ws.send(JSON.stringify({
      type: 'signal',
      data: { sdp: peerConnection.localDescription },
    }));
  }
}

async function handleSignal(signal) {
  console.log('[INTERVIEWEE] handleSignal:', signal.sdp ? `SDP ${signal.sdp.type}` : signal.candidate ? 'ICE candidate' : 'unknown');
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
    await loadIceConfig();
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: true,
    });
    localVideo.srcObject = localStream;

    await connectWebSocket();

    ws.send(JSON.stringify({ type: 'join-room', roomId }));

    joinOverlay.classList.add('hidden');
    setStatus(true, '参加済み — 面談者に接続中 Joined — connecting to interviewer');
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
  setStatus(false, '退出済み Left call');
}

btnJoin.addEventListener('click', joinCall);
btnLeave.addEventListener('click', leaveCall);

btnMute.addEventListener('click', () => {
  audioMuted = !audioMuted;
  localStream?.getAudioTracks().forEach((t) => { t.enabled = !audioMuted; });
  btnMute.textContent = audioMuted ? 'ミュート解除 Unmute' : 'ミュート Mute';
});

btnCam.addEventListener('click', () => {
  cameraOff = !cameraOff;
  localStream?.getVideoTracks().forEach((t) => { t.enabled = !cameraOff; });
  btnCam.textContent = cameraOff ? 'カメラオン Camera On' : 'カメラオフ Camera Off';
});

if (!roomId) {
  setStatus(false, '無効なルームリンク Invalid room link');
  btnJoin.disabled = true;
}
