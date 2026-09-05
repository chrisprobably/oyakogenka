const remoteVideo = document.getElementById('remote-video');
const localVideo = document.getElementById('local-video');
const expressionBadge = document.getElementById('expression-badge');
const transcriptEl = document.getElementById('transcript');
const interimTextEl = document.getElementById('interim-text');
const suggestionsEl = document.getElementById('suggestions');
const suggestionLoading = document.getElementById('suggestion-loading');
const speechStatus = document.getElementById('speech-status');
const connectionStatus = document.getElementById('connection-status');
const statusText = document.getElementById('status-text');
const stageDisplay = document.getElementById('stage-display');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnSuggest = document.getElementById('btn-suggest');
const btnCopy = document.getElementById('btn-copy');
const roleSelect = document.getElementById('role-select');
const shareLink = document.getElementById('share-link');
const roomInfo = document.getElementById('room-info');
const preStartHint = document.getElementById('pre-start-hint');
const waitingOverlay = document.getElementById('waiting-overlay');

let ws = null;
let localStream = null;
let peerConnection = null;
let localRecorder = null;
let remoteRecorder = null;
let expressionInterval = null;
let transcriptEntries = [];
let recentExpressions = [];
let recentSentiments = [];
let isRunning = false;
let roomId = null;

const CHANNEL_INTERVIEWER = 0;
const CHANNEL_INTERVIEWEE = 1;

const EXPRESSION_INTERVAL_MS = 5000;
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:34.61.142.251:3478', username: 'oyako', credential: 'mediation2026' },
];

const LIKELIHOOD_VALUES = {
  UNKNOWN: 0,
  VERY_UNLIKELY: 0.05,
  UNLIKELY: 0.2,
  POSSIBLE: 0.5,
  LIKELY: 0.8,
  VERY_LIKELY: 1.0,
};

function likelihoodToPercent(lk) {
  return (LIKELIHOOD_VALUES[lk] || 0) * 100;
}

function dominantExpression(expr) {
  const scores = {
    '喜び Joy': LIKELIHOOD_VALUES[expr.joy] || 0,
    '悲しみ Sorrow': LIKELIHOOD_VALUES[expr.sorrow] || 0,
    '怒り Anger': LIKELIHOOD_VALUES[expr.anger] || 0,
    '驚き Surprise': LIKELIHOOD_VALUES[expr.surprise] || 0,
  };
  const max = Math.max(...Object.values(scores));
  if (max < 0.3) return '平常 Neutral';
  return Object.keys(scores).find((k) => scores[k] === max);
}

function setStatus(connected, text) {
  connectionStatus.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  statusText.textContent = text;
}

function getSupportedMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function mimeToEncoding(mime) {
  if (mime.includes('webm') || mime.includes('opus')) return 'WEBM_OPUS';
  if (mime.includes('ogg')) return 'OGG_OPUS';
  return 'WEBM_OPUS';
}

function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      setStatus(true, 'サーバー接続済み Connected');
      resolve();
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      handleServerMessage(data);
    };

    ws.onclose = () => {
      setStatus(false, '切断 Disconnected');
    };

    ws.onerror = () => {
      setStatus(false, '接続エラー Connection error');
      reject(new Error('WebSocket connection failed'));
    };
  });
}

function handleServerMessage(data) {
  switch (data.type) {
    case 'room-created':
      roomId = data.roomId;
      const joinUrl = `${location.origin}/join/${roomId}`;
      shareLink.value = joinUrl;
      roomInfo.classList.remove('hidden');
      preStartHint.classList.add('hidden');
      setStatus(true, `ルーム ${roomId} — 対象者の参加待ち Waiting for interviewee`);
      break;

    case 'peer-joined':
      setStatus(true, '対象者接続 — 通話開始 Interviewee connected');
      startWebRTC(true);
      break;

    case 'signal':
      handleSignal(data.data);
      break;

    case 'peer-left':
      setStatus(false, '対象者切断 Interviewee disconnected');
      if (remoteRecorder && remoteRecorder.state !== 'inactive') {
        remoteRecorder.stop();
        remoteRecorder = null;
      }
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }
      remoteVideo.srcObject = null;
      waitingOverlay.classList.remove('hidden');
      speechStatus.textContent = '停止中 Inactive';
      speechStatus.classList.remove('active');
      break;

    case 'transcription':
      handleTranscription(data);
      break;

    case 'error':
      setStatus(false, `Error: ${data.message}`);
      break;
  }
}

async function startWebRTC(isInitiator) {
  console.log('[INTERVIEWER] startWebRTC, initiator:', isInitiator);
  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  const senders = [];
  localStream.getTracks().forEach((track) => {
    console.log('[INTERVIEWER] Adding local track:', track.kind, track.readyState);
    senders.push(peerConnection.addTrack(track, localStream));
  });

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('[INTERVIEWER] ICE candidate:', event.candidate.type, event.candidate.protocol);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'signal',
          data: { candidate: event.candidate },
        }));
      }
    } else {
      console.log('[INTERVIEWER] ICE gathering complete');
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.log('[INTERVIEWER] ICE connection state:', peerConnection.iceConnectionState);
  };

  peerConnection.onicegatheringstatechange = () => {
    console.log('[INTERVIEWER] ICE gathering state:', peerConnection.iceGatheringState);
  };

  let analysisStarted = false;
  peerConnection.ontrack = (event) => {
    console.log('[INTERVIEWER] ontrack fired:', event.track.kind, 'streams:', event.streams?.length);
    const stream = event.streams?.[0] || (() => {
      if (!remoteVideo.srcObject) remoteVideo.srcObject = new MediaStream();
      return remoteVideo.srcObject;
    })();
    if (event.streams?.[0]) {
      remoteVideo.srcObject = stream;
    } else {
      stream.addTrack(event.track);
    }
    remoteVideo.play().catch((e) => console.warn('[INTERVIEWER] play() failed:', e.message));
    waitingOverlay.classList.add('hidden');
    console.log('[INTERVIEWER] Remote stream tracks:', stream.getTracks().map(t => `${t.kind}:${t.readyState}`).join(', '));
    if (!analysisStarted) {
      analysisStarted = true;
      startAnalysis(stream);
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection?.connectionState;
    console.log('[INTERVIEWER] Connection state:', state);
    if (state === 'connected') {
      setStatus(true, '通話中 Call active');
    } else if (state === 'disconnected' || state === 'failed') {
      setStatus(false, `通話${state} Call ${state}`);
    }
  };

  if (isInitiator) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    console.log('[INTERVIEWER] Offer created and sent');
    ws.send(JSON.stringify({
      type: 'signal',
      data: { sdp: peerConnection.localDescription },
    }));
  }
}

async function handleSignal(signal) {
  console.log('[INTERVIEWER] handleSignal:', signal.sdp ? `SDP ${signal.sdp.type}` : signal.candidate ? 'ICE candidate' : 'unknown');
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

function startAnalysis(remoteStream) {
  const audioTracks = remoteStream.getAudioTracks();
  if (audioTracks.length > 0) {
    const audioStream = new MediaStream(audioTracks);
    remoteRecorder = startChannelRecorder('interviewee', CHANNEL_INTERVIEWEE, audioStream);
  }

  expressionInterval = setInterval(analyzeExpression, EXPRESSION_INTERVAL_MS);
}

function startChannelRecorder(channel, tag, audioStream) {
  const mimeType = getSupportedMimeType();
  if (!mimeType) {
    console.error('No supported audio MIME type found');
    return null;
  }

  const encoding = mimeToEncoding(mimeType);

  ws.send(JSON.stringify({
    type: 'start-speech',
    channel,
    encoding,
    sampleRate: 48000,
  }));

  try {
    const recorder = new MediaRecorder(audioStream, { mimeType });

    recorder.ondataavailable = async (event) => {
      if (event.data.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
        const audioBytes = await event.data.arrayBuffer();
        const tagged = new Uint8Array(1 + audioBytes.byteLength);
        tagged[0] = tag;
        tagged.set(new Uint8Array(audioBytes), 1);
        ws.send(tagged.buffer);
      }
    };

    recorder.start(250);
    return recorder;
  } catch (err) {
    console.error(`MediaRecorder error (${channel}):`, err);
    return null;
  }
}

function stopAllRecorders() {
  if (localRecorder && localRecorder.state !== 'inactive') {
    localRecorder.stop();
    localRecorder = null;
  }
  if (remoteRecorder && remoteRecorder.state !== 'inactive') {
    remoteRecorder.stop();
    remoteRecorder = null;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop-speech', channel: 'interviewer' }));
    ws.send(JSON.stringify({ type: 'stop-speech', channel: 'interviewee' }));
  }
}

function handleTranscription(data) {
  const speaker = data.channel === 'interviewee' ? 'Interviewee' : 'Interviewer';
  if (data.isFinal) {
    interimTextEl.textContent = '';
    addTranscriptEntry(speaker, data.transcript, data.confidence, data.languageCode);
    analyzeSentiment(data.transcript);
  } else {
    interimTextEl.textContent = `[${speaker}] ${data.transcript}`;
  }
}

function addTranscriptEntry(speaker, text, confidence, lang) {
  const entry = { speaker, text, confidence, lang, timestamp: new Date(), sentiment: null };
  transcriptEntries.push(entry);

  const placeholder = transcriptEl.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  const div = document.createElement('div');
  div.className = `transcript-entry ${speaker.toLowerCase()}`;
  div.dataset.index = transcriptEntries.length - 1;

  const label = document.createElement('strong');
  label.textContent = speaker;
  label.className = 'speaker-label';
  div.appendChild(label);

  const p = document.createElement('p');
  p.textContent = text;
  div.appendChild(p);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = entry.timestamp.toLocaleTimeString();
  const conf = confidence ? ` | Confidence: ${(confidence * 100).toFixed(0)}%` : '';
  const langLabel = lang ? ` | ${lang}` : '';
  meta.textContent = `${time}${langLabel}${conf}`;
  div.appendChild(meta);

  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

async function analyzeSentiment(text) {
  try {
    const res = await fetch('/api/analyze-sentiment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();

    if (data.sentiment) {
      const lastIdx = transcriptEntries.length - 1;
      transcriptEntries[lastIdx].sentiment = data.sentiment;

      const div = transcriptEl.querySelector(`[data-index="${lastIdx}"]`);
      if (div) {
        const score = data.sentiment.score;
        div.classList.add(score > 0.1 ? 'positive' : score < -0.1 ? 'negative' : 'neutral');

        const meta = div.querySelector('.meta');
        const label = score > 0.1 ? 'ポジティブ Positive' : score < -0.1 ? 'ネガティブ Negative' : '中立 Neutral';
        meta.textContent += ` | 感情 Sentiment: ${label} (${score.toFixed(2)})`;
      }

      if (data.sentences) {
        recentSentiments.push(...data.sentences);
        if (recentSentiments.length > 20) {
          recentSentiments = recentSentiments.slice(-20);
        }
      }
    }
  } catch (err) {
    console.error('Sentiment analysis error:', err);
  }
}

function captureFrame() {
  const videoEl = remoteVideo;
  if (!videoEl.srcObject || videoEl.videoWidth === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.7);
}

async function analyzeExpression() {
  const frame = captureFrame();
  if (!frame) return;

  try {
    const res = await fetch('/api/analyze-expression', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: frame }),
    });
    const data = await res.json();

    if (data.expressions && data.expressions.length > 0) {
      const expr = data.expressions[0];
      updateExpressionUI(expr);
      recentExpressions.push(expr);
      if (recentExpressions.length > 10) {
        recentExpressions = recentExpressions.slice(-10);
      }
    } else {
      expressionBadge.classList.add('hidden');
    }
  } catch (err) {
    console.error('Expression analysis error:', err);
  }
}

function updateExpressionUI(expr) {
  document.getElementById('bar-joy').style.width = likelihoodToPercent(expr.joy) + '%';
  document.getElementById('bar-sorrow').style.width = likelihoodToPercent(expr.sorrow) + '%';
  document.getElementById('bar-anger').style.width = likelihoodToPercent(expr.anger) + '%';
  document.getElementById('bar-surprise').style.width = likelihoodToPercent(expr.surprise) + '%';

  const dominant = dominantExpression(expr);
  expressionBadge.textContent = dominant;
  expressionBadge.classList.remove('hidden');
}

async function getSuggestions() {
  const recentText = transcriptEntries
    .slice(-10)
    .map((e) => `[${e.speaker}] ${e.text}`)
    .join('\n');

  if (!recentText.trim() && recentExpressions.length === 0) {
    suggestionsEl.innerHTML = '<p class="placeholder">データ不足です。会話を続けてから再試行してください Not enough data yet. Continue the conversation and try again.</p>';
    return;
  }

  suggestionsEl.classList.add('hidden');
  suggestionLoading.classList.remove('hidden');
  btnSuggest.disabled = true;

  try {
    const res = await fetch('/api/suggest-questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: recentText,
        expressions: recentExpressions.slice(-5),
        sentiments: recentSentiments.slice(-10),
        intervieweeRole: roleSelect.value,
      }),
    });

    const data = await res.json();
    if (data.stage) {
      stageDisplay.textContent = `段階 Stage: ${data.stage}`;
    }
    suggestionsEl.textContent = data.suggestions || '提案はありません No suggestions available.';
    suggestionsEl.classList.remove('hidden');
    suggestionLoading.classList.add('hidden');
  } catch (err) {
    console.error('Suggestion error:', err);
    suggestionsEl.innerHTML = `<p class="placeholder">提案取得エラー Error getting suggestions: ${err.message}</p>`;
    suggestionsEl.classList.remove('hidden');
    suggestionLoading.classList.add('hidden');
  }

  btnSuggest.disabled = false;
}

async function startSession() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: true,
    });
    localVideo.srcObject = localStream;

    await connectWebSocket();

    ws.send(JSON.stringify({ type: 'create-room' }));

    // Start transcribing local (interviewer) audio immediately
    const localAudio = new MediaStream(localStream.getAudioTracks());
    localRecorder = startChannelRecorder('interviewer', CHANNEL_INTERVIEWER, localAudio);
    speechStatus.textContent = '聴取中 Listening';
    speechStatus.classList.add('active');
    btnSuggest.disabled = false;

    isRunning = true;
    btnStart.disabled = true;
    btnStop.disabled = false;
  } catch (err) {
    console.error('Failed to start session:', err);
    setStatus(false, `Error: ${err.message}`);
  }
}

function stopSession() {
  isRunning = false;
  stopAllRecorders();

  if (expressionInterval) {
    clearInterval(expressionInterval);
    expressionInterval = null;
  }

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
  waitingOverlay.classList.remove('hidden');
  roomInfo.classList.add('hidden');
  preStartHint.classList.remove('hidden');

  btnStart.disabled = false;
  btnStop.disabled = true;
  btnSuggest.disabled = true;
  speechStatus.textContent = '停止中 Inactive';
  speechStatus.classList.remove('active');
  expressionBadge.classList.add('hidden');
  stageDisplay.textContent = '段階 Stage: 待機中 Waiting...';
}

btnStart.addEventListener('click', startSession);
btnStop.addEventListener('click', stopSession);
btnSuggest.addEventListener('click', getSuggestions);
btnCopy.addEventListener('click', () => {
  shareLink.select();
  navigator.clipboard.writeText(shareLink.value);
  btnCopy.textContent = 'コピー済み Copied!';
  setTimeout(() => { btnCopy.textContent = 'コピー Copy'; }, 2000);
});
