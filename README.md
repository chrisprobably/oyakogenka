# Oyako Mediation / 親子間仲裁

A bilingual (Japanese/English) web application for conducting parent-child mediation interviews via video call, with real-time AI-powered analysis.

## Features

- **Video conferencing** — WebRTC peer-to-peer calls between interviewer and interviewee via a shareable join link
- **Speech-to-text** — Real-time transcription of both parties using Google Cloud Speech-to-Text (supports Japanese and English)
- **Facial expression analysis** — Detects joy, sorrow, anger, and surprise from the interviewee's video feed using Google Cloud Vision API
- **Sentiment analysis** — Analyzes transcript text for emotional tone using Google Cloud Natural Language API
- **AI question suggestions** — Gemini 3.8 Flash generates contextual mediator questions based on the conversation, expressions, and sentiment
- **Automatic stage detection** — AI determines the conversation stage (Opening, Story-telling, Exploration, Negotiation, Resolution)
- **Bilingual UI** — All interface strings displayed in Japanese and English

## Architecture

```
Interviewer browser  <--WebRTC-->  Interviewee browser
        |                                  |
        +---------- WebSocket ------------+
                        |
                   Express server
                   /    |    \    \
          Speech API  Vision  NLP  Vertex AI
                      API    API   (Gemini)
```

## Prerequisites

- Node.js 20+
- A Google Cloud project with the following APIs enabled:
  - Cloud Speech-to-Text
  - Cloud Vision
  - Cloud Natural Language
  - Vertex AI
- Google Cloud credentials (`gcloud auth application-default login`)
- A TURN server for NAT traversal in production (e.g. [coturn](https://github.com/coturn/coturn))

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` with your Google Cloud project ID and optionally your TURN server credentials.

3. **Run locally**

   ```bash
   npm start
   ```

   Open `http://localhost:3000` in your browser.

## Usage

1. The interviewer opens the app and clicks **Start**
2. A shareable link appears — send it to the interviewee
3. The interviewee opens the link and clicks **Join**
4. Transcription, expression analysis, and sentiment analysis run automatically
5. Click **Get Suggestions** to receive AI-generated mediator questions

## Deploy to Cloud Run

```bash
gcloud run deploy oyako-mediation \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --max-instances=1 \
  --session-affinity \
  --set-env-vars="TURN_URL=turn:YOUR_IP:3478,TURN_USERNAME=YOUR_USER,TURN_CREDENTIAL=YOUR_PASS"
```

`--max-instances=1` and `--session-affinity` are required so that both peers connect to the same server instance for WebSocket signaling.

For production, deploy a TURN relay server (e.g. coturn on a Compute Engine VM) to handle NAT traversal.

## Project Structure

```
server.js          Express + WebSocket server, API endpoints
public/
  index.html       Interviewer dashboard
  app.js           Interviewer frontend logic
  join.html        Interviewee join page
  join.js          Interviewee frontend logic
  style.css        Shared styles
Dockerfile         Container image for Cloud Run
```


