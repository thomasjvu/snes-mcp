import { SNESButton, SNES_BUTTON_MAP } from './types';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { createCanvas, Canvas } from 'canvas';
import { log } from './utils/logger';

/**
 * Detect whether a ROM is LoROM or HiROM.
 * Checks header checksums at 0x7FC0 (LoROM) and 0xFFC0 (HiROM).
 * Also strips 512-byte SMC copier header if present.
 */
export function detectHiRom(romData: Uint8Array): { data: Uint8Array; isHirom: boolean } {
  let data = romData;

  // Strip 512-byte copier header if present
  if (data.length % 1024 === 512) {
    data = data.slice(512);
  }

  // Check LoROM header at 0x7FDC-0x7FDF
  let loromValid = false;
  if (data.length >= 0x7FE0) {
    const complementLo = data[0x7FDC] | (data[0x7FDD] << 8);
    const checksumLo = data[0x7FDE] | (data[0x7FDF] << 8);
    loromValid = ((complementLo + checksumLo) & 0xFFFF) === 0xFFFF;
  }

  // Check HiROM header at 0xFFDC-0xFFDF
  let hiromValid = false;
  if (data.length >= 0xFFE0) {
    const complementHi = data[0xFFDC] | (data[0xFFDD] << 8);
    const checksumHi = data[0xFFDE] | (data[0xFFDF] << 8);
    hiromValid = ((complementHi + checksumHi) & 0xFFFF) === 0xFFFF;
  }

  // If both valid, prefer HiROM for larger ROMs
  let isHirom = false;
  if (hiromValid && !loromValid) {
    isHirom = true;
  } else if (hiromValid && loromValid) {
    // Both valid — check mapping byte
    const loType = data.length >= 0x7FD6 ? (data[0x7FD5] >> 4) : 0;
    const hiType = data.length >= 0xFFD6 ? (data[0xFFD5] >> 4) : 0;
    isHirom = hiType === 3; // speed bit pattern for HiROM
  }

  return { data, isHirom };
}

// Provide global helpers that SnesJs core expects
(globalThis as any).log = function(text: string) {
  log.debug(`[SnesJs] ${text}`);
};
(globalThis as any).getByteRep = function(val: number) {
  return ('0' + val.toString(16)).slice(-2).toUpperCase();
};
(globalThis as any).getWordRep = function(val: number) {
  return ('000' + val.toString(16)).slice(-4).toUpperCase();
};
(globalThis as any).getLongRep = function(val: number) {
  return ('00000' + val.toString(16)).slice(-6).toUpperCase();
};
(globalThis as any).clearArray = function(arr: any) {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = 0;
  }
};

// Load SnesJs core files — they define globals: Cpu, Spc, Dsp, Apu, Ppu, Cart, Snes
// We need to eval them in order since they reference each other as globals
function loadSnesCore(): any {
  const coreDir = path.join(__dirname, 'snes-core');
  const moduleOrder = ['cart', 'dsp', 'spc', 'apu', 'cpu', 'pipu', 'snes'];

  for (const mod of moduleOrder) {
    const filePath = path.join(coreDir, mod + '.js');
    const content = fs.readFileSync(filePath, 'utf-8');
    // Execute in global context so function declarations and implicit
    // global assignments (e.g. Cpu = ...) land on globalThis
    vm.runInThisContext(content, { filename: mod + '.js' });
  }

  // After eval, Snes should be available as a global
  return (globalThis as any).Snes;
}

let SnesConstructor: any = null;

function getSnesConstructor(): any {
  if (!SnesConstructor) {
    SnesConstructor = loadSnesCore();
  }
  return SnesConstructor;
}

export class SNESEmulator {
  private snes: any;
  private canvas: Canvas;
  private romLoaded: boolean = false;
  private romPath?: string;
  private pixelBuffer: Uint8ClampedArray;

  constructor() {
    // Create a canvas for rendering (SNES resolution: 512x480)
    this.canvas = createCanvas(512, 480);

    // Pixel buffer for RGBA data (512 * 480 * 4 bytes)
    this.pixelBuffer = new Uint8ClampedArray(512 * 480 * 4);

    // Initialize SNES core
    const Snes = getSnesConstructor();
    this.snes = new Snes();
  }

  /**
   * Load a ROM file
   * @param romPath Path to the .smc/.sfc ROM file
   */
  public loadRom(romPath: string): void {
    try {
      const rawData = new Uint8Array(fs.readFileSync(romPath));
      const { data, isHirom } = detectHiRom(rawData);

      log.info(`ROM mapping detected: ${isHirom ? 'HiROM' : 'LoROM'}`);

      const result = this.snes.loadRom(data, isHirom);
      if (result === false) {
        throw new Error('SnesJs loadRom returned false');
      }

      // Reset after loading so the CPU reads the reset vector from the cart
      this.snes.reset(true);

      this.romLoaded = true;
      this.romPath = romPath;
      log.info(`ROM loaded: ${path.basename(romPath)}`);
    } catch (error) {
      log.error(`Error loading ROM: ${error}`);
      throw new Error(`Failed to load ROM: ${error}`);
    }
  }

  /**
   * Press a button on the SNES controller
   * @param button Button to press
   * @param durationFrames Number of frames to hold the button
   */
  public pressButton(button: SNESButton, durationFrames: number = 1): void {
    if (!this.romLoaded) {
      throw new Error('No ROM loaded');
    }

    const buttonNum = SNES_BUTTON_MAP[button];

    // Press the button
    this.snes.setPad1ButtonPressed(buttonNum);

    // Hold for durationFrames
    for (let i = 0; i < durationFrames; i++) {
      this.snes.runFrame(true); // noPpu=true for server-side speed
    }

    // Release the button
    this.snes.setPad1ButtonReleased(buttonNum);

    // Advance one extra frame after release (with PPU for screenshot)
    this.snes.runFrame();
  }

  /**
   * Advance the emulation by one frame
   */
  public doFrame(): void {
    if (!this.romLoaded) {
      throw new Error('No ROM loaded');
    }
    this.snes.runFrame();
  }

  /**
   * Get the current screen as a base64 encoded PNG
   * @returns Base64 encoded PNG image
   */
  public getScreenAsBase64(): string {
    if (!this.romLoaded) {
      throw new Error('No ROM loaded');
    }

    const ctx = this.canvas.getContext('2d');
    const imageData = ctx.createImageData(512, 480);

    // SnesJs setPixels writes RGBA directly into the array
    this.snes.setPixels(imageData.data);

    ctx.putImageData(imageData, 0, 0);

    // Convert to base64 PNG
    return this.canvas.toDataURL('image/png').split(',')[1];
  }

  /**
   * Get the current ROM path
   */
  public getRomPath(): string | undefined {
    return this.romPath;
  }

  /**
   * Check if a ROM is loaded
   */
  public isRomLoaded(): boolean {
    return this.romLoaded;
  }
}
