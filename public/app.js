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
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

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
    Joy: LIKELIHOOD_VALUES[expr.joy] || 0,
    Sorrow: LIKELIHOOD_VALUES[expr.sorrow] || 0,
    Anger: LIKELIHOOD_VALUES[expr.anger] || 0,
    Surprise: LIKELIHOOD_VALUES[expr.surprise] || 0,
  };
  const max = Math.max(...Object.values(scores));
  if (max < 0.3) return 'Neutral';
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
      setStatus(true, 'Connected to server');
      resolve();
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      handleServerMessage(data);
    };

    ws.onclose = () => {
      setStatus(false, 'Disconnected');
    };

    ws.onerror = () => {
      setStatus(false, 'Connection error');
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
      setStatus(true, `Room ${roomId} — waiting for interviewee`);
      break;

    case 'peer-joined':
      setStatus(true, 'Interviewee connected — starting call');
      startWebRTC(true);
      break;

    case 'signal':
      handleSignal(data.data);
      break;

    case 'peer-left':
      setStatus(false, 'Interviewee disconnected');
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
      speechStatus.textContent = 'Inactive';
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
    waitingOverlay.classList.add('hidden');
    startAnalysis(event.streams[0]);
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection?.connectionState;
    if (state === 'connected') {
      setStatus(true, 'Call active');
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
        const label = score > 0.1 ? 'Positive' : score < -0.1 ? 'Negative' : 'Neutral';
        meta.textContent += ` | Sentiment: ${label} (${score.toFixed(2)})`;
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


const TARGET_LABELS = {
  facts: '事実',
  interpretation: '解釈',
  background: '背景',
  interest: '利害',
};

function renderSuggestions(data) {
  suggestionsEl.innerHTML = '';

  if (Array.isArray(data.mixed_statements) && data.mixed_statements.length > 0) {
    const card = document.createElement('div');
    card.className = 'mixed-card';
    const h = document.createElement('div');
    h.className = 'mixed-title';
    h.textContent = '事実と解釈が混ざっている発言';
    card.appendChild(h);
    data.mixed_statements.slice(0, 3).forEach((m) => {
      const row = document.createElement('div');
      row.className = 'mixed-row';
      row.innerHTML =
        `<div class="mixed-quote">「${escapeHtml(m.quote || '')}」</div>` +
        `<div class="mixed-split"><span class="tag tag-facts">事実</span>${escapeHtml(m.fact_part || '')}</div>` +
        `<div class="mixed-split"><span class="tag tag-interpretation">解釈</span>${escapeHtml(m.interpretation_part || '')}</div>`;
      card.appendChild(row);
    });
    suggestionsEl.appendChild(card);
  }

  if (Array.isArray(data.questions) && data.questions.length > 0) {
    const list = document.createElement('div');
    list.className = 'question-list';
    data.questions.forEach((q) => {
      const btn = document.createElement('button');
      btn.className = 'question-btn';
      const target = TARGET_LABELS[q.target] ? q.target : 'facts';
      btn.innerHTML =
        `<span class="tag tag-${target}">${TARGET_LABELS[target]}</span>` +
        `<span class="question-text">${escapeHtml(q.text || '')}</span>` +
        (q.why ? `<span class="question-why">${escapeHtml(q.why)}</span>` : '');
      btn.addEventListener('click', () => askQuestion(q.text || '', target));
      list.appendChild(btn);
    });
    suggestionsEl.appendChild(list);
    return;
  }

  const p = document.createElement('p');
  p.className = 'placeholder';
  p.textContent = data.suggestions || 'No suggestions available.';
  suggestionsEl.appendChild(p);
}

function askQuestion(text, target) {
  // The interviewer chose this question: put it in the script as the interviewer's line.
  const placeholder = transcriptEl.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  const div = document.createElement('div');
  div.className = 'transcript-entry interviewer';
  const p = document.createElement('p');
  p.textContent = text;
  div.appendChild(p);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${new Date().toLocaleTimeString()} | Interviewer | ${TARGET_LABELS[target] || ''}`;
  div.appendChild(meta);
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;

  transcriptEntries.push({ text: `[Interviewer] ${text}`, confidence: null, lang: null, timestamp: new Date(), sentiment: null, interviewer: true });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function getSuggestions() {
  const recentText = transcriptEntries
    .slice(-10)
    .map((e) => `[${e.speaker}] ${e.text}`)
    .join('\n');

  if (!recentText.trim() && recentExpressions.length === 0) {
    suggestionsEl.innerHTML = '<p class="placeholder">Not enough data yet. Continue the conversation and try again.</p>';
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
      stageDisplay.textContent = `Stage: ${data.stage}`;
    }
    renderSuggestions(data);
    suggestionsEl.classList.remove('hidden');
    suggestionLoading.classList.add('hidden');
  } catch (err) {
    console.error('Suggestion error:', err);
    suggestionsEl.innerHTML = `<p class="placeholder">Error getting suggestions: ${err.message}</p>`;
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
    speechStatus.textContent = 'Listening';
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
  speechStatus.textContent = 'Inactive';
  speechStatus.classList.remove('active');
  expressionBadge.classList.add('hidden');
  stageDisplay.textContent = 'Stage: Waiting...';
}

btnStart.addEventListener('click', startSession);
btnStop.addEventListener('click', stopSession);
btnSuggest.addEventListener('click', getSuggestions);
btnCopy.addEventListener('click', () => {
  shareLink.select();
  navigator.clipboard.writeText(shareLink.value);
  btnCopy.textContent = 'Copied!';
  setTimeout(() => { btnCopy.textContent = 'Copy'; }, 2000);
});
