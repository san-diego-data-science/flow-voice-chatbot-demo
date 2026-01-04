const startBtn = document.getElementById('start-btn');
const logsDiv = document.getElementById('logs');
const tripsBody = document.getElementById('trips-body');
const statusDot = document.getElementById('status-dot');
const waveAnim = document.getElementById('wave-anim');

let ws;
let mediaRecorder;
let audioContext;
let audioWorkletNode;
let stream;
let isRecording = false;

// Audio playback queue
const audioQueue = [];
let isPlaying = false;

function log(msg) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.textContent = msg;
    logsDiv.insertBefore(entry, logsDiv.firstChild);
}

function updateTrips(trips) {
    tripsBody.innerHTML = '';
    trips.forEach(trip => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${trip.cliente || '-'}</td>
            <td>${trip.autista || '-'}</td>
            <td>${trip.destinazione || '-'}</td>
            <td>${trip.tipo_viaggio || '-'}</td>
            <td>${trip.data || '-'}</td>
        `;
        tripsBody.appendChild(row);
    });
}

async function playNextAudio() {
    if (isPlaying || audioQueue.length === 0) return;
    isPlaying = true;

    const audioData = audioQueue.shift();

    // Create audio source from base64 PCM
    // We assume 24kHz because Gemini Live output is usually 24kHz
    // But let's check what we receive. Usually 24000.

    // Convert base64 to Float32
    const binaryString = atob(audioData);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768.0;
    }

    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();

    const buffer = audioContext.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.onended = () => {
        isPlaying = false;
        playNextAudio();
    };
    source.start();
}

async function start() {
    if (isRecording) {
        stop();
        return;
    }

    try {
        log("Connecting...");
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(`${proto}://${window.location.host}`);

        ws.onopen = async () => {
            log("Connected to Server");
            statusDot.classList.add('active');
            waveAnim.classList.remove('hidden');
            startBtn.innerHTML = `
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="6" y="4" width="4" height="16"></rect>
                    <rect x="14" y="4" width="4" height="16"></rect>
                </svg>
                Stop Assistant
            `;
            startBtn.classList.add('btn-secondary');
            isRecording = true;

            await startMicrophone();
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'log') {
                log(data.message);
            } else if (data.type === 'trips_update') {
                updateTrips(data.trips);
            } else if (data.type === 'audio') {
                audioQueue.push(data.data);
                playNextAudio();
            }
        };

        ws.onclose = () => {
            log("Disconnected");
            stop();
        };

    } catch (e) {
        log("Error: " + e.message);
    }
}

async function startMicrophone() {
    stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true
        }
    });

    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

    const source = audioContext.createMediaStreamSource(stream);

    // Ensure we process at 16kHz
    // Using ScriptProcessor for high compatibility / simplicity in this demo container
    // A more robust solution would use AudioWorklet
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
        if (!isRecording || ws.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);

        // Downsample/Convert to Int16 PCM
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
            let s = Math.max(-1, Math.min(1, inputData[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Base64 encode
        const buffer = new Uint8Array(pcm16.buffer);
        let binary = '';
        const len = buffer.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(buffer[i]);
        }
        const b64 = btoa(binary);

        ws.send(JSON.stringify({
            type: 'audio',
            data: b64
        }));
    };

    source.connect(processor);
    processor.connect(audioContext.destination); // Needed for Chrome to run the processor
}

function stop() {
    isRecording = false;
    statusDot.classList.remove('active');
    waveAnim.classList.add('hidden');
    startBtn.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <path d="M12 19v4"/>
            <path d="M8 23h8"/>
        </svg>
        Start Assistant
    `;
    startBtn.classList.remove('btn-secondary');

    if (ws) ws.close();
    if (stream) stream.getTracks().forEach(track => track.stop());
    if (audioContext) audioContext.close();
    audioContext = null;
}

startBtn.addEventListener('click', start);
