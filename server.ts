import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, LiveServerMessage } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const port = process.env.PORT || 3000;
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    console.error("GEMINI_API_KEY is not set");
    process.exit(1);
}

app.use(express.static(path.join(__dirname, '../public')));

// Store collected trips to show on UI
let collectedTrips: any[] = [];

// Helper to push updates to all connected clients (for simplicity)
function broadcastTrips() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'trips_update', trips: collectedTrips }));
        }
    });
}

wss.on('connection', async (ws) => {
    console.log("Client connected");

    const ai = new GoogleGenAI({ apiKey });
    const model = 'models/gemini-2.0-flash-exp'; // Using the latest flash exp for speed and audio

    const config = {
        generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: {
                        voiceName: 'Zephyr',
                    }
                }
            },
        },
        systemInstruction: {
            parts: [{
                text: `Sei un assistente vocale sintetico per autisti di trasporti. Parla solo Italiano.
Il tuo obiettivo è raccogliere i dati di un viaggio in modo rapido e preciso.

Dati richiesti (in ordine):
1. CLIENTE: Solo "Altuglas" o "Argos".
2. AUTISTA: Solo "Ivan" o "Genti".
3. DESTINAZIONE:
   - Se Cliente è Altuglas: Solo "Adler" o "Alfa Laval Olmi".
   - Se Cliente è Argos: Solo "Casieri" o "Cassani".
4. TIPO VIAGGIO: "Andata", "Ritorno", "Andata/Ritorno", "Ritorno/Andata".
5. DATA: Default "Oggi" se non specificata.
6. PARTENZA (Opzionale): Stesse opzioni della destinazione.

Comportamento:
- Inizia chiedendo chi è il cliente.
- Sii estremamente sintetico (es: "Cliente?", "Destinazione?", "Confermi?").
- Se l'utente fornisce un dato non valido, correggilo subito elencando le opzioni valide.
- Chiedi conferma di ogni dato importante se l'utente cambia idea.
- Quando hai TUTTI i dati (Cliente, Autista, Destinazione, Tipo, Data), riassumi tutto.
- Chiedi conferma finale.
- Se l'utente dice "Sì" o conferma, chiama la funzione 'saveTrip' e poi dì: "Viaggio creato, vuoi aggiungerne un altro?".
- Se l'utente vuole aggiungerne un altro, ricomincia da capo.

Non inventare destinazioni o nomi non in lista.`
            }]
        },
        tools: [{
            functionDeclarations: [{
                name: "saveTrip",
                description: "Saves the completed trip details.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        cliente: { type: "STRING" },
                        autista: { type: "STRING" },
                        destinazione: { type: "STRING" },
                        tipo_viaggio: { type: "STRING" },
                        data: { type: "STRING" },
                        partenza: { type: "STRING" }
                    },
                    required: ["cliente", "autista", "destinazione", "tipo_viaggio", "data"]
                }
            }]
        }]
    };

    let session: any;

    try {
        session = await ai.live.connect({
            model,
            config
        });
    } catch (e) {
        console.error("Failed to connect to Gemini Live:", e);
        ws.close();
        return;
    }

    // Handle messages from Gemini
    // @ts-ignore - The SDK types might be slightly off for the event emitter pattern used here internally or I need to loop
    // But looking at the provided ai_studio_code.ts, it uses callbacks. Let's use that if possible, or the stream.
    // Wait, the ai_studio_code.ts used `ai.live.connect({ callbacks: ... })`. Let's stick to that pattern as it seems to be what the user has.

    // Re-connecting with callbacks style to match user's working memory of the SDK
    session = await ai.live.connect({
        model,
        config,
        callbacks: {
            onopen: () => {
                console.log("Gemini session opened");
                ws.send(JSON.stringify({ type: 'status', message: 'Connected to Gemini' }));
            },
            onmessage: (msg: LiveServerMessage) => {
                // Handle Audio Response
                if (msg.serverContent?.modelTurn?.parts) {
                    const parts = msg.serverContent.modelTurn.parts;
                    for (const part of parts) {
                        if (part.inlineData && part.inlineData.mimeType?.startsWith('audio/pcm')) {
                            // Send audio to client
                            ws.send(JSON.stringify({
                                type: 'audio',
                                data: part.inlineData.data
                            }));
                        } else if (part.text) {
                            // Send text log
                            ws.send(JSON.stringify({
                                type: 'log',
                                message: `Gemini: ${part.text}`
                            }));
                        }
                    }
                }

                // Handle Turn Complete (maybe sync?)
                if (msg.serverContent?.turnComplete) {
                    // console.log("Turn complete");
                }

                // Handle Tool Call
                if (msg.toolCall) {
                    const functionCalls = msg.toolCall.functionCalls;
                    if (functionCalls) {
                        const responses = [];
                        for (const call of functionCalls) {
                            if (call.name === 'saveTrip') {
                                const args = call.args as any;
                                console.log("Saving trip:", args);
                                collectedTrips.push(args);
                                broadcastTrips(); // Update all UIs

                                responses.push({
                                    name: 'saveTrip',
                                    id: call.id,
                                    response: { result: "Trip saved successfully." }
                                });
                            }
                        }
                        // Send Tool Response back to Gemini
                        session.send({
                            toolResponse: {
                                functionResponses: responses
                            }
                        });
                    }
                }
            },
            onclose: (e) => {
                console.log("Gemini session closed", e);
            },
            onerror: (e) => {
                console.error("Gemini session error", e);
            }
        }
    });

    // Handle messages from Client
    ws.on('message', async (data) => {
        try {
            const parsed = JSON.parse(data.toString());

            if (parsed.type === 'audio') {
                // parsed.data is base64 PCM 16kHz mono (hopefully)
                // Send to Gemini
                // The structure for realtime input:
                await session.send({
                    realtimeInput: {
                        mediaChunks: [{
                            mimeType: "audio/pcm;rate=16000",
                            data: parsed.data // base64 string
                        }]
                    }
                });
            } else if (parsed.type === 'start') {
                // Nothing specific needed, session is already open
            }
        } catch (e) {
            console.error("Error processing client message", e);
        }
    });

    ws.on('close', () => {
        if (session) {
            session.close();
        }
    });

    // Send initial trips state
    ws.send(JSON.stringify({ type: 'trips_update', trips: collectedTrips }));
});

server.listen(port, () => {
    console.log(`Server started on http://localhost:${port}`);
});
