import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import axios from 'axios';

// Load environment variables
dotenv.config();

// API keys
const HUME_API_KEY = process.env.KeEMk4eYoT4MLx0VVFrrTbycAyVvFAl41lPPWmFweTnnpsrZ || '';
const OPENAI_API_KEY = process.env.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 || '';

// Initialize Express
const app = express();

// Middleware
app.use(cors({
  origin: '*', // For development - restrict this in production
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "connect-src": ["'self'", "wss://api.hume.ai", "https://api.openai.com"]
    }
  }
}));
app.use(morgan('dev')); // Logging
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Add health check endpoint
app.get('/', (req, res) => {
  res.send({
    status: 'ok',
    message: 'WebSocket server is running',
    docs: 'Connect using Socket.IO client'
  });
});

// Set up Socket.io
const io = new Server(server, {
  cors: {
    origin: '*', // For development - restrict this in production
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
});

// Store active Hume.ai connections
const humeConnections = new Map<string, WebSocket>();

// Map to throttle requests to GPT
const gptThrottleMap = new Map<string, number>();

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Send welcome message to confirm connection
  socket.emit('welcome', { message: 'Successfully connected to WebSocket server!' });
  
  // Start session
  socket.on('start_session', async () => {
    try {
      console.log(`Starting session for client ${socket.id}`);
      socket.emit('status', { message: 'Starting emotion analysis session...' });
      
      // Connect to Hume.ai
      const humeWs = new WebSocket('wss://api.hume.ai/v0/stream/models', {
        headers: {
          'Authorization': `Bearer ${HUME_API_KEY}`
        }
      });
      
      // Store the connection
      humeConnections.set(socket.id, humeWs);
      
      // Handle WebSocket open
      humeWs.on('open', () => {
        console.log(`Hume.ai connection established for client ${socket.id}`);
        
        // Send configuration
        const config = {
          config: {
            models: {
              face: {},
              prosody: {},
              language: {}
            },
            raw_output: false
          }
        };
        humeWs.send(JSON.stringify(config));
        
        // Notify frontend
        socket.emit('hume_connected');
      });
      
      // Process messages from Hume.ai
      humeWs.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          
          // Only process prediction messages
          if (message.predictions) {
            console.log('Received predictions from Hume.ai');
            
            // Extract emotional data
            const emotionalData = extractEmotionalData(message);
            
            // Send raw data to frontend
            socket.emit('emotional_data', emotionalData);
            
            // Process with GPT-4o-mini (throttled)
            if (shouldProcessWithGPT(socket.id)) {
              const gptAnalysis = await analyzeWithGPT(emotionalData);
              socket.emit('gpt_analysis', gptAnalysis);
            }
          }
        } catch (error) {
          console.error('Error processing Hume.ai message:', error);
        }
      });
      
      // Handle Hume.ai errors
      humeWs.on('error', (error) => {
        console.error(`Hume.ai WebSocket error for client ${socket.id}:`, error);
        socket.emit('hume_error', { message: 'Connection error with emotion analysis service' });
      });
      
      // Handle Hume.ai connection close
      humeWs.on('close', () => {
        console.log(`Hume.ai connection closed for client ${socket.id}`);
        socket.emit('hume_disconnected');
      });
    } catch (error) {
      console.error('Error starting session:', error);
      socket.emit('error', { message: 'Failed to start analysis session' });
    }
  });
  
  // Handle video frames
  socket.on('video_frame', (frameData: string) => {
    const humeWs = humeConnections.get(socket.id);
    if (humeWs && humeWs.readyState === WebSocket.OPEN) {
      // Format the frame data for Hume.ai
      const payload = {
        data: {
          media: frameData,
          source_info: {
            source_id: socket.id,
            timestamp_ms: Date.now()
          }
        }
      };
      humeWs.send(JSON.stringify(payload));
    }
  });
  
  // Handle audio data
  socket.on('audio_data', (audioData: string) => {
    const humeWs = humeConnections.get(socket.id);
    if (humeWs && humeWs.readyState === WebSocket.OPEN) {
      // Format the audio data for Hume.ai
      const payload = {
        data: {
          media: audioData,
          source_info: {
            source_id: socket.id,
            timestamp_ms: Date.now(),
            media_type: 'audio'
          }
        }
      };
      humeWs.send(JSON.stringify(payload));
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Close Hume.ai connection
    const humeWs = humeConnections.get(socket.id);
    if (humeWs) {
      humeWs.close();
      humeConnections.delete(socket.id);
    }
    
    // Clean up throttle map
    gptThrottleMap.delete(socket.id);
  });
});

// Helper function to extract emotional data
function extractEmotionalData(message: any) {
  const data: any = {
    timestamp: Date.now(),
    face: null,
    speech: null,
    language: null
  };
  
  if (message.predictions) {
    // Extract facial emotions if available
    if (message.predictions.face) {
      data.face = {
        emotions: message.predictions.face.emotions || {},
      };
    }
    
    // Extract speech/prosody data if available
    if (message.predictions.prosody) {
      data.speech = {
        emotions: message.predictions.prosody.emotions || {},
      };
    }
    
    // Extract language data if available
    if (message.predictions.language) {
      data.language = {
        text: message.predictions.language.text || '',
      };
    }
  }
  
  return data;
}

// Function to determine if we should process with GPT
function shouldProcessWithGPT(clientId: string): boolean {
  const now = Date.now();
  const lastProcessed = gptThrottleMap.get(clientId) || 0;
  
  // Only process once every 3 seconds
  if (now - lastProcessed > 3000) {
    gptThrottleMap.set(clientId, now);
    return true;
  }
  
  return false;
}

// Function to analyze emotional data with GPT-4o-mini
async function analyzeWithGPT(emotionalData: any) {
  try {
    // Format the emotional data for GPT
    let emotionsText = 'No emotional data available';
    let speechText = 'No speech data available';
    let transcriptText = 'No transcript available';
    
    if (emotionalData.face) {
      const faceEmotions = emotionalData.face.emotions;
      const topEmotions = Object.entries(faceEmotions)
        .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
        .slice(0, 4)
        .map(([emotion, value]) => `${emotion}: ${(Number(value) * 100).toFixed(1)}%`);
      
      emotionsText = topEmotions.join(', ');
    }
    
    if (emotionalData.speech) {
      const speechEmotions = emotionalData.speech.emotions;
      const topSpeechEmotions = Object.entries(speechEmotions)
        .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
        .slice(0, 4)
        .map(([emotion, value]) => `${emotion}: ${(Number(value) * 100).toFixed(1)}%`);
      
      speechText = topSpeechEmotions.join(', ');
    }
    
    if (emotionalData.language && emotionalData.language.text) {
      transcriptText = emotionalData.language.text;
    }
    
    // Make request to OpenAI API
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an emotionally intelligent assistant analyzing real-time emotional and speech data. Provide brief, helpful insights about the person\'s emotional state and provide supportive feedback. Keep responses concise (2-3 sentences max) and focused on emotional well-being.'
        },
        {
          role: 'user',
          content: `
            Here's the current emotional analysis data:
            - Facial emotions: ${emotionsText}
            - Speech tone: ${speechText}
            - Transcript (if available): "${transcriptText}"
            
            Based on this real-time data, provide a brief insight about the emotional state and one supportive response.
          `
        }
      ],
      max_tokens: 150
    }, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    return {
      analysis: response.data.choices[0].message.content,
      timestamp: Date.now(),
      rawData: {
        faceEmotions: emotionsText,
        speechTone: speechText,
        transcript: transcriptText
      }
    };
  } catch (error: any) {
    console.error('Error calling OpenAI API:', error.message);
    return {
      analysis: 'Sorry, I was unable to analyze the emotional data at this time.',
      timestamp: Date.now(),
      error: true
    };
  }
}

// Create fallback for non-WebSocket requests
app.get('/status', (req, res) => {
  res.json({
    status: 'running',
    connections: humeConnections.size,
    uptime: process.uptime()
  });
});

// Start server
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// For Vercel serverless deployment
export default app;
