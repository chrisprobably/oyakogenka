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
  generationConfig: { responseMimeType: 'application/json', temperature: 0.6 },
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
  let recognizeStream = null;
  let roomId = null;
  let role = null;

  const startSpeechStream = (encoding, sampleRate) => {
    if (recognizeStream) {
      recognizeStream.end();
    }
    recognizeStream = speechClient
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
            transcript: result.alternatives[0].transcript,
            isFinal: result.isFinal,
            confidence: result.alternatives[0].confidence,
            languageCode: result.languageCode,
          }));
        }
      })
      .on('error', (err) => {
        console.error('Speech stream error:', err.message);
        if (recognizeStream) {
          recognizeStream = null;
          setTimeout(() => {
            if (ws.readyState === ws.OPEN) {
              startSpeechStream(encoding, sampleRate);
            }
          }, 1000);
        }
      })
      .on('end', () => {
        recognizeStream = null;
      });
  };

  ws.on('message', (message) => {
    if (typeof message === 'string') {
      const data = JSON.parse(message);

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
          startSpeechStream(data.encoding, data.sampleRate);
          break;
        }

        case 'stop-speech': {
          if (recognizeStream) {
            recognizeStream.end();
            recognizeStream = null;
          }
          break;
        }
      }
    } else {
      if (recognizeStream) {
        recognizeStream.write(message);
      }
    }
  });

  ws.on('close', () => {
    if (recognizeStream) {
      recognizeStream.end();
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

    const partyLabel = intervieweeRole === 'parent' ? 'the father (chairman)' : 'the son (vice-chairman)';

    const prompt = `You are the neutral agent of a statutory auditor who is consulted separately by a father (chairman) and his son (vice-chairman) running a family medical corporation. You assist the interviewer during a one-on-one video interview with ONE party: ${partyLabel}.

Your job is to help the interviewer collect this party's account without taking sides:
1. FACTS - what happened, as observable events (who did what, when, where, what was said)
2. INTERPRETATION - how this party reads those events (why they think it happened, what it meant)
3. BACKGROUND - history that makes them see it that way (relationships, past events, loyalties)
4. INTEREST - what they want to protect or obtain (not their position, but the need behind it)

Rules:
- Never persuade, never advise, never evaluate. Do not propose solutions.
- Never mention what the other party said.
- When a statement mixes fact and interpretation (e.g. "he shouted at him because he hates me"), suggest a question that separates them ("What exactly was said, and by whom?" then "What made you feel it was directed at you?").
- When words and expression disagree (e.g. says "it's fine" while sorrow is high), gently explore that.
- Questions must be open-ended, one idea each, in polite spoken Japanese if the transcript is Japanese, otherwise English.

Recent transcript:
${transcript || '(No speech yet)'}

Recent facial expressions (Google Cloud Vision):
${expressionSummary || '(No expression data)'}

Sentence sentiment (Google Natural Language):
${sentimentSummary || '(No sentiment data)'}

Return ONLY JSON in this shape:
{
  "stage": "Opening | Story-telling | Exploration | Negotiation | Resolution",
  "facts_so_far": ["observable event 1", "..."],
  "interpretations_so_far": ["this party's reading 1", "..."],
  "mixed_statements": [{"quote": "...", "fact_part": "...", "interpretation_part": "..."}],
  "questions": [
    {"text": "...", "target": "facts | interpretation | background | interest", "why": "one short reason (cue from words/expression)"}
  ]
}
Give 3 to 5 questions. At least one must target "facts" and at least one "interest".`;

    const result = await geminiModel.generateContent(prompt);
    const response = result.response;
    const text = response.candidates[0].content.parts[0].text;

    let parsed;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*|```\s*$/g, '').trim());
    } catch (e) {
      // Fallback: keep the old text shape so the UI still shows something
      parsed = { stage: 'Exploration', facts_so_far: [], interpretations_so_far: [], mixed_statements: [], questions: [], suggestions: text };
    }

    res.json({
      stage: parsed.stage || 'Exploration',
      facts_so_far: parsed.facts_so_far || [],
      interpretations_so_far: parsed.interpretations_so_far || [],
      mixed_statements: parsed.mixed_statements || [],
      questions: parsed.questions || [],
      suggestions: parsed.suggestions || null,
    });
  } catch (err) {
    console.error('Gemini API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
