import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';

// Initialize SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Set up file storage using multer (for temporary video files)
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Ensure unique filenames to prevent clobbering
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({ storage });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '100mb' }));

  // API endpoint for biomechanical video analysis
  app.post('/api/analyze-video', upload.single('video'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No video file provided.' });
      }

      console.log(`Analyzing video: ${req.file.path}`);

      // We use the Gemini File API to handle potentially large video files
      const uploadResult = await ai.files.upload({
        file: req.file.path,
        config: {
          mimeType: req.file.mimetype,
        }
      });

      console.log('Video uploaded to Gemini. Awaiting processing...');

      // Polling for video processing completion
      let fileStatus = await ai.files.get({ name: uploadResult.name });
      let attempts = 0;
      while (fileStatus.state === 'PROCESSING' && attempts < 30) { // Max ~30 seconds wait
        await new Promise(resolve => setTimeout(resolve, 1000));
        fileStatus = await ai.files.get({ name: uploadResult.name });
        attempts++;
      }

      if (fileStatus.state === 'FAILED') {
        throw new Error('Video processing failed on Gemini servers.');
      }

      // Instruct Gemini to assume the role of an expert biomechanics analyst
      const systemInstruction = `You are an elite swimming biomechanics analyst system (like Omni-Swim). 
Analyze this swimming video. Estimate or extract key performance metrics. You MUST return valid JSON conforming to the requested schema.`;

      const prompt = `Analyze this swimming performance and provide realistic, quantitative estimations for the requested metrics.
Include detailed splits, calculate distance per stroke, underwater kick tempo, and identify key technique elements.`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: [
          uploadResult,
          prompt,
        ],
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              splits: {
                type: Type.ARRAY,
                description: 'Estimated splits. Assume a standardized pool length (e.g. 50m) unless otherwise discernible. Array of split objects.',
                items: {
                  type: Type.OBJECT,
                  properties: {
                    lap: { type: Type.INTEGER },
                    time: { type: Type.NUMBER, description: 'Split time in seconds' },
                    distance: { type: Type.INTEGER, description: 'Distance mark (e.g., 50, 100)' },
                  },
                },
              },
              avgVelocity: { type: Type.NUMBER, description: 'Overall average velocity in m/s' },
              strokeRate: { type: Type.NUMBER, description: 'Average stroke rate in strokes per minute' },
              distancePerStroke: { type: Type.NUMBER, description: 'Average distance per stroke in meters' },
              fatigueIndex: { type: Type.NUMBER, description: 'Estimated fatigue index (drop off in pace/DPS from start to finish) as a percentage' },
              underwaterKickTempo: { type: Type.NUMBER, description: 'Estimated underwater dolphin kick tempo in kicks per minute' },
              diveVelocity: { type: Type.NUMBER, description: 'Peak velocity off the blocks in m/s' },
              diveDistance: { type: Type.NUMBER, description: 'Distance in meters traveled during the dive entry before first surfacing' },
              analysisNotes: { type: Type.STRING, description: 'A short qualitative summary of technique and areas for improvement.' },
            },
            required: [
              'splits', 'avgVelocity', 'strokeRate', 'distancePerStroke', 
              'fatigueIndex', 'underwaterKickTempo', 'diveVelocity', 
              'diveDistance', 'analysisNotes'
            ],
          },
        },
      });

      const rawJson = response.text;
      if (!rawJson) {
         throw new Error('Gemini returned an empty response.');
      }
      
      const parsedData = JSON.parse(rawJson);

      // Clean up local temp file and remote Gemini file to free space/quotas
      fs.unlinkSync(req.file.path);
      try {
        await ai.files.delete({ name: uploadResult.name });
      } catch (err) {
         console.warn('Could not delete remote gemini file', err);
      }

      res.json(parsedData);
    } catch (error: any) {
      console.error('Error analyzing video:', error);
      res.status(500).json({ error: error.message || 'An error occurred during analysis.' });
    }
  });


  // Vite development middleware OR production static hosting
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
