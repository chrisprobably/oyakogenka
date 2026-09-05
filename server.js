require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const speech = require('@google-cloud/speech');
const vision = require('@google-cloud/vision');
const language = require('@google-cloud/language');
const { VertexAI } = require('@google-cloud/vertexai');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const speechClient = new speech.SpeechClient();
const visionClient = new vision.ImageAnnotatorClient();
const languageClient = new language.LanguageServiceClient();

const vertexAI = new VertexAI({
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
});

const geminiModel = vertexAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
});

const rooms = new Map();

function createRoom() {
  const id = crypto.randomBytes(4).toString('hex');
  rooms.set(id, { interviewer: null, interviewee: null });
  return id;
}

app.get('/join/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

wss.on('connection', (ws) => {
  const speechStreams = {};
  let roomId = null;
  let role = null;

  const startSpeechStream = (channel, encoding, sampleRate) => {
    if (speechStreams[channel]) {
      speechStreams[channel].end();
    }
    const stream = speechClient
      .streamingRecognize({
        config: {
          encoding: encoding || 'WEBM_OPUS',
          sampleRateHertz: sampleRate || 48000,
          languageCode: 'ja-JP',
          alternativeLanguageCodes: ['en-US'],
          enableAutomaticPunctuation: true,
          model: 'latest_long',
        },
        interimResults: true,
      })
      .on('data', (data) => {
        const result = data.results[0];
        if (result) {
          ws.send(JSON.stringify({
            type: 'transcription',
            channel,
            transcript: result.alternatives[0].transcript,
            isFinal: result.isFinal,
            confidence: result.alternatives[0].confidence,
            languageCode: result.languageCode,
          }));
        }
      })
      .on('error', (err) => {
        console.error(`Speech stream error (${channel}):`, err.message);
        speechStreams[channel] = null;
        setTimeout(() => {
          if (ws.readyState === ws.OPEN) {
            startSpeechStream(channel, encoding, sampleRate);
          }
        }, 1000);
      })
      .on('end', () => {
        speechStreams[channel] = null;
      });
    speechStreams[channel] = stream;
  };

  ws.on('message', (message, isBinary) => {
    if (!isBinary) {
      const data = JSON.parse(message.toString());

      switch (data.type) {
        case 'create-room': {
          roomId = createRoom();
          role = 'interviewer';
          rooms.get(roomId).interviewer = ws;
          ws.send(JSON.stringify({ type: 'room-created', roomId }));
          break;
        }

        case 'join-room': {
          roomId = data.roomId;
          const room = rooms.get(roomId);
          if (!room) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
            return;
          }
          role = 'interviewee';
          room.interviewee = ws;
          ws.send(JSON.stringify({ type: 'room-joined', roomId }));

          if (room.interviewer && room.interviewer.readyState === ws.OPEN) {
            room.interviewer.send(JSON.stringify({ type: 'peer-joined' }));
          }
          break;
        }

        case 'signal': {
          const room = rooms.get(roomId);
          if (!room) return;
          const peer = role === 'interviewer' ? room.interviewee : room.interviewer;
          if (peer && peer.readyState === ws.OPEN) {
            peer.send(JSON.stringify({ type: 'signal', data: data.data }));
          }
          break;
        }

        case 'start-speech': {
          const channel = data.channel || 'default';
          startSpeechStream(channel, data.encoding, data.sampleRate);
          break;
        }

        case 'stop-speech': {
          const channel = data.channel || 'default';
          if (speechStreams[channel]) {
            speechStreams[channel].end();
            speechStreams[channel] = null;
          }
          break;
        }
      }
    } else {
      // Binary audio data: first byte is channel tag (0=interviewer, 1=interviewee)
      const tag = message[0];
      const audioData = message.slice(1);
      const channel = tag === 1 ? 'interviewee' : 'interviewer';
      if (speechStreams[channel] && audioData.length > 0) {
        speechStreams[channel].write(audioData);
      }
    }
  });

  ws.on('close', () => {
    for (const key of Object.keys(speechStreams)) {
      if (speechStreams[key]) {
        speechStreams[key].end();
      }
    }
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      const peer = role === 'interviewer' ? room.interviewee : room.interviewer;
      if (peer && peer.readyState === ws.OPEN) {
        peer.send(JSON.stringify({ type: 'peer-left' }));
      }
      if (role === 'interviewer') {
        room.interviewer = null;
      } else {
        room.interviewee = null;
      }
      if (!room.interviewer && !room.interviewee) {
        rooms.delete(roomId);
      }
    }
  });
});

app.post('/api/analyze-expression', async (req, res) => {
  try {
    const { image } = req.body;
    const imageBuffer = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ''), 'base64');

    const [result] = await visionClient.faceDetection({ image: { content: imageBuffer } });
    const faces = result.faceAnnotations || [];

    const expressions = faces.map((face) => ({
      joy: face.joyLikelihood,
      sorrow: face.sorrowLikelihood,
      anger: face.angerLikelihood,
      surprise: face.surpriseLikelihood,
      confidence: face.detectionConfidence,
      bounds: face.boundingPoly?.vertices,
    }));

    res.json({ expressions });
  } catch (err) {
    console.error('Vision API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analyze-sentiment', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.trim().length === 0) {
      return res.json({ sentiment: null });
    }

    const [result] = await languageClient.analyzeSentiment({
      document: { content: text, type: 'PLAIN_TEXT' },
    });

    const sentiment = result.documentSentiment;
    const sentences = (result.sentences || []).map((s) => ({
      text: s.text.content,
      score: s.sentiment.score,
      magnitude: s.sentiment.magnitude,
    }));

    res.json({
      sentiment: {
        score: sentiment.score,
        magnitude: sentiment.magnitude,
      },
      sentences,
    });
  } catch (err) {
    console.error('Language API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/suggest-questions', async (req, res) => {
  try {
    const { transcript, expressions, sentiments, intervieweeRole } = req.body;

    const expressionSummary = expressions
      .map((e, i) => `[${i + 1}] Joy: ${e.joy}, Sorrow: ${e.sorrow}, Anger: ${e.anger}, Surprise: ${e.surprise}`)
      .join('\n');

    const sentimentSummary = sentiments
      .map((s) => `"${s.text}" (sentiment: ${s.score > 0 ? 'positive' : s.score < 0 ? 'negative' : 'neutral'}, intensity: ${s.magnitude.toFixed(2)})`)
      .join('\n');

    const prompt = `You are an expert family mediator specializing in parent-child conflict resolution.
You are assisting an interviewer who is conducting a mediation session via video call.

FIRST, analyze the conversation and determine the current stage. Stages are:
- **Opening**: Greetings, introductions, building rapport, explaining the process
- **Story-telling**: Each party shares their perspective, initial accounts of the conflict
- **Exploration**: Deeper probing into feelings, needs, and underlying interests
- **Negotiation**: Working toward understanding, finding common ground, proposing solutions
- **Resolution**: Agreements forming, commitments being made, wrapping up

Output the detected stage on the first line as: STAGE: <stage name>

THEN suggest 3-5 thoughtful, empathetic questions based on the interviewee's verbal responses and emotional state.

Guidelines:
- Questions should be open-ended and non-judgmental
- Consider both the spoken words AND the detected emotions
- If there is a mismatch between words and expressions (e.g., saying "I'm fine" while showing sorrow), gently explore that
- Adapt your language to be appropriate for the interviewee (${intervieweeRole === 'parent' ? 'parent/adult' : 'child/young person'})
- Focus on understanding feelings, needs, and perspectives
- Avoid leading questions or taking sides
- Respond in the same language as the transcript (Japanese or English)

**Recent Transcript**:
${transcript || '(No speech yet)'}

**Recent Facial Expressions** (from Google Cloud Vision):
${expressionSummary || '(No expression data)'}

**Text Sentiment Analysis**:
${sentimentSummary || '(No sentiment data)'}

For each question, briefly explain why you are suggesting it (what emotional or verbal cue prompted it).`;

    const result = await geminiModel.generateContent(prompt);
    const response = result.response;
    const text = response.candidates[0].content.parts[0].text;

    let stage = 'Opening';
    const stageMatch = text.match(/^STAGE:\s*(.+)$/m);
    if (stageMatch) {
      stage = stageMatch[1].trim();
    }

    const suggestions = text.replace(/^STAGE:.*$/m, '').trim();

    res.json({ suggestions, stage });
  } catch (err) {
    console.error('Gemini API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
