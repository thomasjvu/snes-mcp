import {
  CallToolResult,
  TextContent
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SNESButton } from './types';
import { EmulatorService } from './emulatorService';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './utils/logger';

export function registerSNESTools(server: McpServer, emulatorService: EmulatorService): void {
  // Register button press tools
  Object.values(SNESButton).forEach(button => {
    server.tool(
      `press_${button.toLowerCase()}`,
      `Press the ${button} button on the SNES controller`,
      {
        duration_frames: z.number().int().positive().optional().default(25).describe('Number of frames to hold the button'),
        include_screenshot: z.boolean().optional().default(true).describe('Whether to include a screenshot in the response (default true). Set to false to save context window space when you don\'t need to see the screen.')
      },
      async ({ duration_frames, include_screenshot }): Promise<CallToolResult> => {
        emulatorService.pressButton(button, duration_frames);
        if (include_screenshot) {
          const screen = emulatorService.getScreen();
          return { content: [screen] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ button, frames: duration_frames }) }] };
      }
    );
  });

  // Register wait_frames tool
  server.tool(
    'wait_frames',
    'Wait for a specified number of frames',
    {
      duration_frames: z.number().int().positive().describe('Number of frames to wait').default(100),
      include_screenshot: z.boolean().optional().default(true).describe('Whether to include a screenshot in the response (default true). Set to false to save context window space when you don\'t need to see the screen.')
    },
    async ({ duration_frames, include_screenshot }): Promise<CallToolResult> => {
      emulatorService.waitFrames(duration_frames);
      if (include_screenshot) {
        const screen = emulatorService.getScreen();
        return { content: [screen] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ waited_frames: duration_frames }) }] };
    }
  );

  // Register load ROM tool
  server.tool(
    'load_rom',
    'Load an SNES ROM file',
    {
      romPath: z.string().describe('Path to the .smc or .sfc ROM file')
    },
    async ({ romPath }): Promise<CallToolResult> => {
      const screen = emulatorService.loadRom(romPath);
      return { content: [screen] };
    }
  );

  // Register get screen tool
  server.tool(
    'get_screen',
    'Get the current SNES screen (advances one frame)',
    {},
    async (): Promise<CallToolResult> => {
      const screen = emulatorService.advanceFrameAndGetScreen();
      return { content: [screen] };
    }
  );

  // Register is_rom_loaded tool
  server.tool(
    'is_rom_loaded',
    'Check if a ROM is currently loaded in the emulator',
    {},
    async (): Promise<CallToolResult> => {
      const isLoaded = emulatorService.isRomLoaded();
      const romPath = emulatorService.getRomPath();

      const responseText: TextContent = {
        type: 'text',
        text: JSON.stringify({
          romLoaded: isLoaded,
          romPath: romPath || null
        })
      };

      log.verbose('Checked ROM loaded status', JSON.stringify({
        romLoaded: isLoaded,
        romPath: romPath || null
      }));

      return { content: [responseText] };
    }
  );

  // Register list_roms tool
  server.tool(
    'list_roms',
    'List all available SNES ROM files',
    {},
    async (): Promise<CallToolResult> => {
      try {
        const romsDir = path.join(process.cwd(), 'roms');

        if (!fs.existsSync(romsDir)) {
          fs.mkdirSync(romsDir);
          log.info('Created roms directory');
        }

        const romFiles = fs.readdirSync(romsDir)
          .filter(file => file.endsWith('.smc') || file.endsWith('.sfc'))
          .map(file => ({
            name: file,
            path: path.join(romsDir, file)
          }));

        const responseText: TextContent = {
          type: 'text',
          text: JSON.stringify(romFiles)
        };

        log.verbose('Listed available ROMs', JSON.stringify({
          count: romFiles.length,
          roms: romFiles
        }));

        return { content: [responseText] };
      } catch (error) {
        log.error('Error listing ROMs:', error instanceof Error ? error.message : String(error));

        const errorText: TextContent = {
          type: 'text',
          text: JSON.stringify({
            error: 'Failed to list ROMs',
            message: error instanceof Error ? error.message : String(error)
          })
        };

        return { content: [errorText] };
      }
    }
  );
}
