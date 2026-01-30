import { SNESEmulator } from './snes';
import { SNESButton } from './types';
import { ImageContent } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './utils/logger';
import type { WsSync } from './wsSync';

export class EmulatorService {
  private emulator: SNESEmulator;
  private wsSync?: WsSync;

  constructor(emulator: SNESEmulator) {
    this.emulator = emulator;
    log.info('EmulatorService initialized');
  }

  setWsSync(wsSync: WsSync): void {
    this.wsSync = wsSync;
  }

  isRomLoaded(): boolean {
    return this.emulator.isRomLoaded();
  }

  getRomPath(): string | undefined {
    return this.emulator.getRomPath();
  }

  loadRom(romPath: string): ImageContent {
    log.info(`Attempting to load ROM: ${romPath}`);
    if (!fs.existsSync(romPath)) {
      log.error(`ROM file not found: ${romPath}`);
      throw new Error(`ROM file not found: ${romPath}`);
    }

    try {
      this.emulator.loadRom(romPath);
      log.info(`ROM loaded successfully: ${path.basename(romPath)}`);

      // Advance a few frames to initialize the screen
      for (let i = 0; i < 5; i++) {
        this.emulator.doFrame();
      }
      log.verbose('Advanced initial frames after ROM load');
      this.wsSync?.broadcastRomLoaded();

      return this.getScreen();
    } catch (error) {
      log.error(`Error loading ROM: ${romPath}`, error instanceof Error ? error.message : String(error));
      throw new Error(`Failed to load ROM: ${romPath}. Reason: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  pressButton(button: SNESButton, durationFrames: number): void {
    log.debug(`Pressing button: ${button}`);
    if (!this.isRomLoaded()) {
      log.warn('Attempted to press button with no ROM loaded');
      throw new Error('No ROM loaded');
    }
    this.emulator.pressButton(button, durationFrames);
    this.wsSync?.broadcastButtonPress(button, durationFrames);
  }

  /** Press button on server emulator only, no broadcast (for browser-originated inputs) */
  pressButtonLocal(button: SNESButton, durationFrames: number): void {
    if (!this.isRomLoaded()) return;
    this.emulator.pressButton(button, durationFrames);
  }

  waitFrames(durationFrames: number): void {
    log.debug(`Waiting for ${durationFrames} frames`);
    if (!this.isRomLoaded()) {
      log.warn('Attempted to wait frames with no ROM loaded');
      throw new Error('No ROM loaded');
    }
    for (let i = 0; i < durationFrames; i++) {
      this.emulator.doFrame();
    }
    log.verbose(`Waited ${durationFrames} frames`);
  }

  getScreen(): ImageContent {
    log.verbose('Getting current screen');
    if (!this.isRomLoaded()) {
      log.warn('Attempted to get screen with no ROM loaded');
      throw new Error('No ROM loaded');
    }
    const screenBase64 = this.emulator.getScreenAsBase64();
    const screen: ImageContent = {
      type: 'image',
      data: screenBase64,
      mimeType: 'image/png'
    };
    return screen;
  }

  advanceFrameAndGetScreen(): ImageContent {
    log.verbose('Advancing one frame and getting screen');
    if (!this.isRomLoaded()) {
      log.warn('Attempted to advance frame with no ROM loaded');
      throw new Error('No ROM loaded');
    }
    this.emulator.doFrame();
    return this.getScreen();
  }
}
