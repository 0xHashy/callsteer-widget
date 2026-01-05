// CallSteer Audio Service - Real Microphone Capture
// Streams microphone audio to Deepgram for transcription

const DEEPGRAM_API_KEY = 'fbd2742fdb1be9c89ff2681a5f35d504d0bd1ad8';
const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true&interim_results=true&punctuate=true&encoding=linear16&sample_rate=16000';

class AudioService {
  constructor() {
    console.log('[AudioService] Initialized');

    this.stream = null;
    this.socket = null;
    this.audioContext = null;
    this.processor = null;
    this.source = null;
    this.isRecording = false;
    this.callId = null;

    // Callbacks
    this.onTranscript = null;
    this.onError = null;
    this.onStatusChange = null;
  }

  generateCallId() {
    return 'call_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  async startRecording() {
    if (this.isRecording) {
      console.warn('[AudioService] Already recording');
      return true;
    }

    try {
      console.log('[AudioService] Requesting microphone access...');

      // Request microphone permission
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      console.log('[AudioService] Microphone access granted!');
      this.callId = this.generateCallId();

      // Connect to Deepgram
      await this.connectToDeepgram();

      // Start sending audio to Deepgram
      this.startStreaming();

      this.isRecording = true;
      this.notifyStatus('connected', 'Listening...');

      return true;

    } catch (error) {
      console.error('[AudioService] Microphone error:', error);

      if (error.name === 'NotAllowedError') {
        this.notifyError('Microphone permission denied. Please allow access.');
      } else if (error.name === 'NotFoundError') {
        this.notifyError('No microphone found.');
      } else {
        this.notifyError('Could not access microphone: ' + error.message);
      }

      this.cleanup();
      return false;
    }
  }

  async connectToDeepgram() {
    return new Promise((resolve, reject) => {
      console.log('[AudioService] Connecting to Deepgram...');

      this.socket = new WebSocket(DEEPGRAM_URL, ['token', DEEPGRAM_API_KEY]);

      const timeout = setTimeout(() => {
        if (this.socket && this.socket.readyState !== WebSocket.OPEN) {
          reject(new Error('Deepgram connection timeout'));
        }
      }, 10000);

      this.socket.onopen = () => {
        clearTimeout(timeout);
        console.log('[AudioService] Deepgram connected!');
        resolve();
      };

      this.socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.channel?.alternatives?.[0]?.transcript) {
            const transcript = data.channel.alternatives[0].transcript;
            const isFinal = data.is_final;

            if (transcript.trim()) {
              console.log(`[AudioService] ${isFinal ? 'FINAL' : 'interim'}: "${transcript}"`);

              if (isFinal) {
                this.notifyTranscript(transcript, 'customer');
              }
            }
          }
        } catch (err) {
          console.error('[AudioService] Error parsing Deepgram message:', err);
        }
      };

      this.socket.onerror = (error) => {
        clearTimeout(timeout);
        console.error('[AudioService] Deepgram error:', error);
        this.notifyError('Speech recognition connection failed');
        reject(error);
      };

      this.socket.onclose = (event) => {
        console.log('[AudioService] Deepgram disconnected:', event.code, event.reason);
        if (this.isRecording) {
          this.notifyStatus('disconnected', 'Reconnecting...');
        }
      };
    });
  }

  startStreaming() {
    console.log('[AudioService] Starting audio stream...');

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextClass({ sampleRate: 16000 });

    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmData = this.convertFloat32ToInt16(inputData);
        this.socket.send(pcmData.buffer);
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);

    console.log('[AudioService] Audio streaming started');
  }

  convertFloat32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
  }

  stopRecording() {
    console.log('[AudioService] Stopping...');

    const callInfo = {
      callId: this.callId,
      duration: 0
    };

    this.isRecording = false;
    this.cleanup();

    console.log('[AudioService] Stopped');
    return callInfo;
  }

  cleanup() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {}
      this.socket = null;
    }

    if (this.processor) {
      try {
        this.processor.disconnect();
      } catch (e) {}
      this.processor = null;
    }

    if (this.source) {
      try {
        this.source.disconnect();
      } catch (e) {}
      this.source = null;
    }

    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
    }

    if (this.stream) {
      try {
        this.stream.getTracks().forEach(track => track.stop());
      } catch (e) {}
      this.stream = null;
    }

    this.callId = null;
  }

  notifyTranscript(transcript, speaker) {
    if (this.onTranscript) {
      this.onTranscript(transcript, speaker, this.callId);
    }
  }

  notifyStatus(status, message) {
    console.log(`[AudioService] Status: ${status} - ${message}`);
    if (this.onStatusChange) {
      this.onStatusChange(status, message);
    }
  }

  notifyError(message) {
    console.error(`[AudioService] Error: ${message}`);
    if (this.onError) {
      this.onError(message);
    }
  }

  getCallId() {
    return this.callId;
  }
}

// Export for use in renderer
window.AudioService = AudioService;
