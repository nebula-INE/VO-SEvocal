// src/wasmEngine.ts

export async function loadWasmEngine() {
  if ((window as any).VoseEngineReady) return (window as any).Module;
  
  return new Promise((resolve, reject) => {
    (window as any).Module = {
      onRuntimeInitialized: () => {
        (window as any).VoseEngineReady = true;
        resolve((window as any).Module);
      },
      print: (text: string) => console.log('[VOSE WASM]', text),
      printErr: (text: string) => console.error('[VOSE WASM ERR]', text)
    };

    const script = document.createElement('script');
    script.src = '/vose_core.js';
    script.onerror = reject;
    document.body.appendChild(script);
  });
}

export async function renderWasm(notes: any[], tempo: number, voicebank: string): Promise<string | null> {
  const Module = await loadWasmEngine();
  
  const FRAME_PERIOD_MS = 5.0;
  const structSize = 44; // 32-bit WASM: 11 pointers/ints of 4 bytes each
  const notesPtr = Module._malloc(structSize * notes.length);
  const ptrsToFree: number[] = [];
  
  try {
    // 1. Download and write sample WAV files to Emscripten MEMFS
    for (const n of notes) {
      const wavPathStr = "/" + n.lyric + ".wav";
      const exists = (() => {
        try {
          return Module.FS.stat(wavPathStr) !== null;
        } catch(e) { return false; }
      })();
      
      if (!exists) {
        // Fetch audio from server
        const res = await fetch(`/api/py/voicebank-sample?name=${encodeURIComponent(voicebank)}&alias=${encodeURIComponent(n.lyric)}`);
        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          Module.FS.writeFile(wavPathStr, new Uint8Array(arrayBuf));
        } else {
          console.warn(`Could not load sample for ${n.lyric}`);
        }
      }
    }

    // 2. Populate CNoteEvent array
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const offset = notesPtr + i * structSize;

      const wavPathStr = "/" + n.lyric + ".wav";
      const wavPathPtr = Module.allocate(Module.intArrayFromString(wavPathStr), 'i8', Module.ALLOC_NORMAL);
      ptrsToFree.push(wavPathPtr);
      Module.setValue(offset + 0, wavPathPtr, 'i32');

      const durationSec = (n.length / 480) * (60 / tempo);
      const pitchLength = Math.ceil((durationSec * 1000) / FRAME_PERIOD_MS) || 1;
      
      const baseFreq = 440 * Math.pow(2, (n.noteNum - 69) / 12);
      
      const allocateDoubleArray = (val: number, length: number) => {
          const ptr = Module._malloc(length * 8);
          ptrsToFree.push(ptr);
          for(let j=0; j<length; j++) {
              Module.setValue(ptr + j*8, val, 'double');
          }
          return ptr;
      };
      
      const pitchCurvePtr = allocateDoubleArray(baseFreq, pitchLength);
      Module.setValue(offset + 4, pitchCurvePtr, 'i32');
      Module.setValue(offset + 8, pitchLength, 'i32');
      
      const genderPtr = allocateDoubleArray(0.5, pitchLength);
      Module.setValue(offset + 12, genderPtr, 'i32');
      
      const tensionPtr = allocateDoubleArray(0.5, pitchLength);
      Module.setValue(offset + 16, tensionPtr, 'i32');
      
      const breathPtr = allocateDoubleArray(0.5, pitchLength);
      Module.setValue(offset + 20, breathPtr, 'i32');
      
      const vibDepthPtr = allocateDoubleArray(0.0, pitchLength);
      Module.setValue(offset + 24, vibDepthPtr, 'i32');
      
      const vibRatePtr = allocateDoubleArray(0.0, pitchLength);
      Module.setValue(offset + 28, vibRatePtr, 'i32');
      
      Module.setValue(offset + 32, pitchLength, 'i32');
      
      const portPtr = allocateDoubleArray(0.0, pitchLength);
      Module.setValue(offset + 36, portPtr, 'i32');
      Module.setValue(offset + 40, pitchLength, 'i32');
    }

    const outputPathStr = "/output.wav";
    const outputPathPtr = Module.allocate(Module.intArrayFromString(outputPathStr), 'i8', Module.ALLOC_NORMAL);
    ptrsToFree.push(outputPathPtr);

    // Call execute_render(NoteEvent* notes, int note_count, const char* output_path, int mode_flag)
    Module._execute_render(notesPtr, notes.length, outputPathPtr, 0);

    let wavData: Uint8Array | null = null;
    try {
        wavData = Module.FS.readFile(outputPathStr);
    } catch (e) {
        console.error("Failed to read output.wav from MEMFS", e);
    }

    if (wavData) {
        const blob = new Blob([wavData.buffer], { type: 'audio/wav' });
        return URL.createObjectURL(blob);
    }
    
    return null;
  } finally {
    // Cleanup
    Module._free(notesPtr);
    ptrsToFree.forEach(ptr => Module._free(ptr));
  }
}
